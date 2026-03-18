import cds from '@sap/cds';

export default function registerHandlersForSimilarEntities(srv) {
	srv.before('READ', async (req) => {
		if (req.subject.ref.at(-1) === 'relatedEntities' && req.target['@ai.relatedEntities']) {
			req.subject.ref.pop();
			const model = cds.context.model ?? cds.model;
			const dbEntity = model.definitions[req.target['@ai.relatedEntities']];
			const vectors = Object.keys(dbEntity.elements).filter((e) => dbEntity.elements[e].type === 'cds.Vector');
			if (!vectors.length) return [];
			const whereClause = [];
			const notSelf = [];
			for (const key in req.target.keys) {
				if (whereClause.length) {
					whereClause.push('and');
					notSelf.push('and');
				}
				whereClause.push({ ref: [key] }, '=', { val: req.params[0][key] });
				notSelf.push({ ref: [key] }, '!=', { val: req.params[0][key] });
			}
			const record = await SELECT.one
				.from(dbEntity)
				.where(whereClause)
				.columns(vectors.map((v) => ({ ref: [v] })));

			req.query.SELECT.from.ref = [req.target['@ai.relatedEntities']];
			req.query.SELECT.where = req.query.SELECT.where ? [{ xpr: req.query.SELECT.where }, 'and', { xpr: notSelf }] : notSelf;
			req.query.SELECT.columns ??= ['*'];
			const scores = [];
			for (const vector of vectors) {
				scores.push({
					func: 'COSINE_SIMILARITY',
					args: [{ ref: [vector] }, { val: record[vector] }],
					as: `SCORE_${vector}`
				});
			}
			const scoreIdx = req.query.SELECT.columns.findIndex((e) => e.ref && e.ref[0] === 'score');
			if (scoreIdx >= 0) {
				req.query.SELECT.columns.splice(scoreIdx, 1);
			}
			const xpr = scores.reduce(
				(acc, val, idx) => {
					acc.unshift(val);
					if (idx < scores.length - 1) {
						acc.unshift('+');
					} else {
						acc.unshift('(');
					}
					return acc;
				},
				[')', '/', { val: scores.length }]
			);
			req.query.SELECT.columns.push({ xpr: xpr, as: 'score' });
			req.query.SELECT.orderBy.unshift({ xpr: xpr, as: 'score2', sort: 'desc' });
		}
	});
	srv.after('READ', async (res, req) => {
		if (req.target['@ai.relatedEntities']) {
			res.$count = 10;
			for (const record of res) {
				record.score = Math.round(record.score * 10000) / 100;
			}
		}
	});
}
