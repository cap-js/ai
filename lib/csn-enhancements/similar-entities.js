export default function addSimilarEntitiesAssociation(q, entityName, model) {
	q.columns ??= ['*'];
	const entity = model.definitions[entityName];
	const newEntity = structuredClone(entity);
	const newQ = newEntity.projection || newEntity.query.SELECT;
	newQ.from.ref[0] === entityName;
	if (newEntity.elements.SAP_Recommendations) {
		newQ.excluding ??= [];
		if (!q.excluding.some((exC) => exC === 'SAP_Recommendations')) {
			q.excluding.push('SAP_Recommendations');
		}
		delete newEntity.elements.SAP_Recommendations;
	}
	newQ.columns ??= ['*'];
	newEntity.elements.score = {
		type: 'cds.Decimal',
		'@Common.Label': '{i18n>SimilarityScore}',
		'@Measures.Unit': '%'
	};
	newQ.columns.push({
		virtual: true,
		cast: { type: 'cds.Decimal', precision: 4, scale: 2 },
		as: 'score'
	});
	newEntity['@UI.LineItem'].unshift({
		Value: { '=': 'score' }
	});
	newEntity['@ai.relatedEntities'] = q.from.ref[0];
	delete newEntity['@odata.draft.enabled'];
	delete newEntity['@UI.Facets'];
	delete newEntity['@cds.redirection.target'];
	model.definitions[entityName + '.related'] = newEntity;
	const col = {
		on: [{ val: 1 }, '=', { val: 1 }],
		target: entityName + '.related',
		cardinality: { max: '*' },
		type: 'cds.Association'
	};
	entity.elements['relatedEntities'] = col;
	if (!q.columns.some((c) => c.as === 'relatedEntities')) {
		q.columns.push({
			as: 'relatedEntities',
			cast: col
		});
		if (entity['@UI.Facets']) {
			entity['@UI.Facets'].push({
				$Type: 'UI.ReferenceFacet',
				ID: 'VECTOR_RELATED_ENTITIES',
				Target: 'relatedEntities/@UI.LineItem',
				Label: 'Related books',
				'@UI.Hidden': { $edmJson: { $Not: { $Path: 'IsActiveEntity' } } }
			});
		}
	}
}
