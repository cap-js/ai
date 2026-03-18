import cds from '@sap/cds';
import path from 'path';
import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';
// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let { GET, axios } = cdsTest(path.join(__dirname, './bookshop'));

describe('Embedding based search', () => {
	axios.defaults.auth = { username: 'alice' };

	let query = null;
	before(async () => {
		const db = await cds.connect.to('db');
		db.before('READ', (req) => {
			if (req.target && req.target.name === 'CatalogService.Books') {
				query = req.query;
			}
		});
	});
	test('Searching on an entity leverages embedding search', async () => {
		const { status } = await GET(`/odata/v4/catalog/Books?$search=Jane`);
		assert.strictEqual(status, 200);
		assert.ok(query.SELECT.where.some((ele) => ele.func === 'cosine_similarity'));
	});

	test('cds.search for the embedding source is disabled', async () => {
		const { status } = await GET(`/odata/v4/catalog/Books?$search=Jane`);
		assert.strictEqual(status, 200);
		assert.ok(cds.model.definitions['CatalogService.Books']['@cds.search.descr'] === false);
		assert.strictEqual(
			query.SELECT.where.at(-1).args[0].list.some((r) => r.ref[0] === 'descr'),
			false
		);
	});

	test('@Search.fuzzinessThreshold is used as the threshold', async () => {
		const { status } = await GET(`/odata/v4/catalog/Books?$search=Jane`);
		assert.strictEqual(status, 200);
		assert.ok(query.SELECT.where.at(-1).func);
		const similarityScore = query.SELECT.where.find((ele, idx) => ele.val && query.SELECT.where[idx - 2]?.func === 'cosine_similarity' && query.SELECT.where[idx - 2]?.args[0]?.ref[0] === 'defaultDescr_embedding');
		assert.strictEqual(similarityScore?.val, 0.5);
	});

	test('cds.env.hana.fuzzy is used as the default threshold', async () => {
		cds.env.hana.fuzzy = 0.2;
		const { status } = await GET(`/odata/v4/catalog/Books?$search=Jane`);
		assert.strictEqual(status, 200);
		assert.ok(query.SELECT.where.at(-1).func);
		const similarityScore = query.SELECT.where.find((ele, idx) => ele.val && query.SELECT.where[idx - 2]?.func === 'cosine_similarity' && query.SELECT.where[idx - 2]?.args[0]?.ref[0] === 'descr_embedding');
		assert.strictEqual(similarityScore?.val, 0.2);

		delete cds.env.hana.fuzzy;
	});

	test('Regular search is or´ed together', async () => {
		const { status } = await GET(`/odata/v4/catalog/Books?$search=Jane`);
		assert.strictEqual(status, 200);
		assert.ok(query.SELECT.where.at(-1).func);
		assert.strictEqual(query.SELECT.where.at(-2), 'or');
	});
});

describe('@ai.embedding', () => {
	axios.defaults.auth = { username: 'alice' };

	test('@ai.embedding adds a vector column', async () => {
		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr);
		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr['@ai.embedding']);

		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding);
		assert.strictEqual(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding.type, 'cds.Vector');
		assert.strictEqual(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding.value.stored, true);
		assert.strictEqual(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding.value.func, 'VECTOR_EMBEDDING');
		assert.strictEqual(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding.value.args[0].ref[0], 'descr');
	});

	test('@ai.embedding.@ai.model specifies the model', async () => {
		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr);
		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr['@ai.embedding']);
		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr['@ai.embedding.@ai.model']);

		assert.ok(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding);
		assert.strictEqual(cds.model.definitions['sap.capire.bookshop.Books'].elements.descr_embedding.value.args[2].val, cds.model.definitions['sap.capire.bookshop.Books'].elements.descr['@ai.embedding.@ai.model']);
	});

	test('cds.env.ai.embeddings.defaultModel is the default model for generated columns', async () => {
		cds.env.ai.embeddings.defaultModel = 'SAP_NEB.20240715';
		let csn = await cds.load(['../bookshop/srv', '@cap-js/ai/srv/AICoreService']);
		csn = cds.compile.for.nodejs(csn);

		assert.ok(csn.definitions['sap.capire.bookshop.Books'].elements.defaultDescr_embedding);
		assert.strictEqual(csn.definitions['sap.capire.bookshop.Books'].elements.defaultDescr_embedding.value.args[2].val, cds.env.ai.embeddings.defaultModel);

		cds.env.ai.embeddings.defaultModel = 'SAP_GXY.20250407';
	});

	test('cds.env.ai.embeddings.remoteSource is the default HANA remote source for generated columns', async () => {
		cds.env.ai.embeddings.remoteSource = 'TEST_REMOTE_SOURCE';
		const csn = await cds.load(['../bookshop/srv', '@cap-js/ai/srv/AICoreService']);
		const hdbArtefacts = cds.compile.to.hana(csn);
		for (const [artefact, { file }] of hdbArtefacts) {
			if (file.startsWith('sap.capire.bookshop.Books')) {
				assert.ok(artefact.match(/embedding REAL_VECTOR GENERATED ALWAYS AS \(VECTOR_EMBEDDING\(descr, 'DOCUMENT', 'text-embedding-ada-002', TEST_REMOTE_SOURCE\)\)/));
				break;
			}
		}

		cds.env.ai.embeddings.defaultModel = 'SAP_GXY.20250407';
	});
});
