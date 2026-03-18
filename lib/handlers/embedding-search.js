import cds from '@sap/cds';
import cqn4sql from '@cap-js/db-service/lib/cqn4sql.js';

export default function registerHandlersForEmbeddingSearch(srv) {
	srv.before('READ', async (req) => {
		if (!req.query.SELECT.search || !req.target['@ai.embeddingSearch']?.length || req.target.isDraft) return;

		const where = generateEmbeddingSearchClause(req.query.SELECT.search[0]?.val, req.target);

		// Use cqn4sql to get search func for regular search so it
		// can be combined with vector search
		const cqn = cqn4sql(req.query, cds.context.model ?? cds.model);

		delete req.query.SELECT.search;

		if (cqn.SELECT.where.at(-1).SELECT.where[0].args[0].list) {
			cqn.SELECT.where.at(-1).SELECT.where[0].args[0].list.forEach((ele) => {
				if (ele.ref[0].startsWith('$')) {
					ele.ref.shift();
				}
			});
		} else if (cqn.SELECT.where.at(-1).SELECT.where[0].args[0].ref) {
			const ele = cqn.SELECT.where.at(-1).SELECT.where[0].args[0].ref;
			if (ele.ref[0].startsWith('$')) {
				ele.ref.shift();
			}
		}
		where.push('or', cqn.SELECT.where.at(-1).SELECT.where[0]);

		req.query.SELECT.where = req.query.SELECT.where?.length ? [{ xpr: req.query.SELECT.where }, 'and', { xpr: where }] : where;
	});
}

function generateEmbeddingSearchClause(searchTerm, entity) {
	const where = [];
	for (const { '=': vector } of entity['@ai.embeddingSearch']) {
		if (where.length) where.push('or');
		where.push(
			{
				func: 'cosine_similarity',
				args: [
					{ ref: [vector] },
					{
						func: 'VECTOR_EMBEDDING',
						args: [{ val: searchTerm }, { val: 'QUERY' }, { val: entity.elements[vector]?.['@ai.model'] ?? cds.env.ai.embeddings.defaultModel }]
					}
				]
			},
			'>',
			{ val: entity.elements[vector]?.['@Search.fuzzinessThreshold'] ?? cds.env.hana?.fuzzy ?? 0.7 }
		);
	}
	return where;
}
