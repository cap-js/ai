import cds from '@sap/cds';
// import addSimilarEntitiesAssociation from './similar-entities.js';
const LOG = cds.log('ai-embeddings');

const enhancedFlagEmbeddings = 'sap.cds.embeddings';

const entitiesWithRemoteSrv = {};
const entitiesWithEmbedding = {};

export default function enhanceModel(model) {
	if (model.meta.flavor !== 'inferred' || model.meta[enhancedFlagEmbeddings]) return;
	for (const name in model.definitions) {
		const entity = model.definitions[name];
		if (entity.kind !== 'entity') {
			continue;
		}
		if (entity.projection || entity.query) {
			const q = entity.projection ?? entity.query.SELECT;
			const source = model.definitions[q.from.ref[0]];
			for (const ele in entity.elements) {
				const element = entity.elements[ele];
				const aiAnnotations = Object.keys(element).filter((k) => k.startsWith('@ai.embedding'));
				if (aiAnnotations.length) {
					const alias = q.columns?.find((c) => c.as === ele)?.ref[0];
					if (aiAnnotations.some((k) => !source.elements[alias ?? ele]?.[k])) {
						LOG.error(`@ai.embedding annotation annotated to view ${name}! Embedding annotations must be on fields of a non projected or selected entity!`);
					}
				}
			}
		}
		const exclCols = [];
		for (const ele in entity.elements) {
			const element = entity.elements[ele];

			if (element['@ai.embedding']) {
				exclCols.push(ele + '_embedding');
				entity.elements[ele + '_embedding'] = {
					'@Core.Computed': true,
					type: 'cds.Vector',
					value: {
						stored: true,
						func: 'VECTOR_EMBEDDING',
						args: [{ ref: [ele] }, { val: 'DOCUMENT' }, { val: element['@ai.embedding.@ai.model'] ?? cds.env.ai.embeddings.defaultModel }]
					}
				};
				if (element['@Search.fuzzinessThreshold']) {
					entity.elements[ele + '_embedding']['@Search.fuzzinessThreshold'] = element['@Search.fuzzinessThreshold'];
				}
				if (element['@ai.embedding.@ai.model']) {
					entity.elements[ele + '_embedding']['@ai.model'] = element['@ai.embedding.@ai.model'];
				}
				// Disable search on column with vector to use vector instead
				entity[`@cds.search.${ele}`] = false;
				entity[`@ai.embeddingSearch`] ??= [];
				entity[`@ai.embeddingSearch`].push({ '=': ele + '_embedding' });
				const query = entity.query?.SELECT || entity.projection;
				if (query && query.columns && !query.columns.some((c) => c === '*')) {
					delete entity.elements[ele + '_embedding'];
				} else if (query) {
					delete entity.elements[ele + '_embedding'].value;
				}
				entitiesWithEmbedding[name] = 1;
			} else if (element.type === 'cds.Vector') {
				entitiesWithEmbedding[name] = 1;
			}
		}
		entitiesWithRemoteSrv[name] = exclCols;
	}

	// for (const name in model.definitions) {
	// 	const entity = model.definitions[name]
	// 	if (entity.kind !== 'entity') {
	// 		continue;
	// 	}
	// 	if (entity.projection || entity.query) {
	// 		const q = entity.projection || entity.query.SELECT;
	// if (entitiesWithRemoteSrv[q.from.ref[0]] && entity['@odata.draft.enabled'] && entity['@UI.LineItem']) {
	// 	addSimilarEntitiesAssociation(q, name, model)
	// }
	// 		continue;
	// 	}
	// }

	model.meta[enhancedFlagEmbeddings] = true;
}

/**
 * OData cannot render cds.Vector in EDM. Removing all Vector columns here.
 * The function is intended to run for the compile event for EDMX, so that runtime and DB still know
 * about the cds.Vectors and only rendering is avoided.
 * @param {*} model CSN Model
 */
export function excludeVectors(model) {
	for (const name in model.definitions) {
		const entity = model.definitions[name];
		if (entity.kind !== 'entity') {
			continue;
		}
		if (entity.projection || entity.query) {
			const q = entity.projection || entity.query.SELECT;
			for (const ele in entity.elements) {
				const col = entity.elements[ele];
				if (entity.elements[ele] && col.type === 'cds.Vector' && (!q.excluding || !q.excluding.some((exC) => exC === ele))) {
					entity.elements[ele]['@cds.api.ignore'] = true;
				}
			}
			continue;
		}
	}
}

const _hdi_migration = cds.compiler.to.hdi.migration;
cds.compiler.to.hdi.migration = function (csn, options, beforeImage) {
	// Loop is done as part of HDI and not generic enhanceModel because in generic it is not
	// possible to distinguish when the CSN is compiled for HANA
	for (const name in csn.definitions) {
		const entity = csn.definitions[name];
		if (entity.kind !== 'entity') {
			continue;
		}
		if (entity.projection || entity.query) {
			continue;
		}
		for (const ele in entity.elements) {
			const element = entity.elements[ele];

			// If the model is an AI Core model and the model is for HANA,
			// a fourth parameter specifying the remote service is needed
			if (element.value?.func === 'VECTOR_EMBEDDING' && !element.value?.args?.[2]?.val?.startsWith('SAP') && element.value?.args?.length === 3) {
				element.value.args.push({ func: cds.env.ai.embeddings.remoteSource, args: [] });
				entitiesWithRemoteSrv[name] = 1;
			}
		}
	}
	const res = _hdi_migration(csn, options, beforeImage);
	for (const def of res.definitions) {
		if (entitiesWithRemoteSrv[def.name]) {
			def.sql = def.sql.replaceAll(`${cds.env.ai.embeddings.remoteSource}()`, cds.env.ai.embeddings.remoteSource);
		}
	}
	return res;
};
