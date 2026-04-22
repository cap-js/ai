import cds from '@sap/cds';
const LOG = cds.log('@cap-js/ai');

export default function registerHandlersForRecommendations(srv) {
	srv.prepend(() =>
		srv.on('READ', async (req, next) => {
			// Recommendations annotation is missing on draft entity, thus req.target.actives
			if (
				!req.target.isDraft ||
				!req.target.actives['@UI.Recommendations'] ||
				!req.query.elements[req.target['@UI.Recommendations']['=']] ||
				req._?.event === 'draftActivate'
			) {
				return next();
			}

			const model = cds.context.model ?? cds.model;
			const recommendationsStruct = req.target.actives['@UI.Recommendations']['='];
			const recommendationsDefinition =
				model.definitions[req.target.actives.elements[recommendationsStruct].target];

			const columns = Object.keys(req.target.actives.elements).filter(
				(ele) =>
					ele !== 'modifiedAt' &&
					ele !== 'modifiedBy' &&
					ele !== 'createdAt' &&
					ele !== 'createdBy' &&
					req.target.actives.elements[ele].type !== 'cds.LargeBinary' &&
					req.target.actives.elements[ele].type !== 'cds.Vector'
			);

			const recommendationsIdx = req.query.SELECT.columns.findIndex(
				(col) => col.ref && col.ref[0] === req.target['@UI.Recommendations']['=']
			);
			if (recommendationsIdx >= 0) {
				req.query.SELECT.columns.splice(recommendationsIdx, 1);
			}

			const fieldsWithRecommendations = structuredClone(recommendationsDefinition.elements);
			delete fieldsWithRecommendations.technicalRecommendationsIdentifier;

			const where = Object.keys(fieldsWithRecommendations).reduce((acc, field) => {
				if (acc.length) acc.push('and');
				acc.push({ ref: [field] }, 'is', 'not', 'null');
				return acc;
			}, []);

			const dynamicRecommendations = Object.keys(fieldsWithRecommendations).reduce((acc, field) => {
				if (req.target.elements[field]['@UI.RecommendationState']?.xpr) {
					acc.push(
						Object.assign({
							xpr: req.target.elements[field]['@UI.RecommendationState'].xpr.map(stringifyVals),
							as: `SAP_RECOMMENDATION_STATE_${field}`,
							cast: { type: 'cds.Integer' }
						})
					);
				}
				return acc;
			}, []);

			// Ensure all three queries have a column "ID", if entity does not have ID field, concat keys to make an ID column
			if (Object.keys(req.target.keys).length > 1 || !req.target.keys.ID) {
				const xpr = Object.keys(req.target.keys).reduce((acc, val) => {
					if (acc.length) acc.push('||');
					acc.push({ val: val }, '||', { ref: [val] });
					return acc;
				}, []);
				req.query.SELECT.columns.push({ xpr, as: 'SAP_RECOMMENDATIONS_ID' });
				columns.push({ xpr, as: 'SAP_RECOMMENDATIONS_ID' });
			}

			// Parallelize actual request and retrieval of records send to RPT-1
			const [records, resWithAllColumns, res] = await Promise.all([
				// The 2000 limit is based on https://help.sap.com/docs/sap-ai-core/generative-ai/sap-rpt-1?locale=en-US; we use the small model, e.g. 2048 max rows; recommended is 2000, thus 2000
				SELECT.from(req.target.actives).columns(columns).where(where).limit(2000),
				SELECT.from(req.subject).columns(columns.concat(dynamicRecommendations)),
				next()
			]);

			if (!res) return res;
			const fieldsWithDisabledRecommendations = {};
			const response = Array.isArray(res) ? res : [res];
			const aiCore = await cds.connect.to('AICore');
			const contextRows = records.filter((r) => !response.some((rr) => matchRow(r, rr)));
			for (const row of response) {
				const propsToDelete = Object.keys(row).filter((prop) =>
					prop.startsWith(req.target['@UI.Recommendations']['='])
				);
				for (const prop of propsToDelete) {
					delete row[prop];
				}

				const predictionRow = resWithAllColumns.find((r) => matchRow(r, row));
				if (!predictionRow) {
					continue;
				}
				delete predictionRow.DraftAdministrativeData_DraftUUID;
				delete predictionRow.HasActiveEntity;
				delete predictionRow.IsActiveEntity;
				for (const ele in fieldsWithRecommendations) {
					if (
						predictionRow[`SAP_RECOMMENDATION_STATE_${ele}`] === undefined ||
						predictionRow[`SAP_RECOMMENDATION_STATE_${ele}`] != 0
					) {
						predictionRow[ele] = '[PREDICT]';
					} else {
						fieldsWithDisabledRecommendations[ele] = 1;
					}
				}
				for (const ele of Object.keys(predictionRow).filter((ele) =>
					ele.startsWith(`SAP_RECOMMENDATION_STATE_`)
				)) {
					delete predictionRow[ele];
				}
				contextRows.push(predictionRow);
			}

			const { predictions, details } = await aiCore.fetchPredictions({
				rows: contextRows,
				entity: req.target.name,
				predictionColumns: Object.keys(fieldsWithRecommendations)
			});
			LOG.debug(details);

			const descriptionSELECTs = [];
			for (const ele in fieldsWithRecommendations) {
				const textPath = req.target.actives.elements[ele]?.['@Common.Text']?.['='];
				if (textPath) {
					descriptionSELECTs.push(
						SELECT.from(req.target.actives)
							.columns(`${textPath} as SAP_Recommendations_Descr_${ele}`, ele)
							.where([
								{ ref: textPath.split('.') },
								'is',
								'not',
								'null',
								'and',
								{ ref: [ele] },
								'in',
								{
									list: (predictions ?? []).reduce(
										(acc, val) => {
											if (val[ele]) {
												acc.push(...val[ele].map((pred) => ({ val: pred.prediction })));
											}
											return acc;
										},
										[{ val: null }]
									)
								}
							])
							.limit(predictions?.length ?? 1)
					);
				} else {
					descriptionSELECTs.push(Promise.resolve([]));
				}
			}
			const descriptionRows = await Promise.all(descriptionSELECTs);

			if (!predictions) {
				LOG.debug('Could not fetch any predictions and thus cannot apply any recommendations!');
			}
			// Put predictions into recommendations struct to show them on the UI
			for (const row of response) {
				const prediction = predictions?.find((r) => matchRow(r, row));
				row[recommendationsStruct] = {};
				if (prediction) {
					const elements = Object.keys(fieldsWithRecommendations);
					for (let i = 0; i < elements.length; i++) {
						const ele = elements[i];
						// Skip recommendations for a field
						if (fieldsWithDisabledRecommendations[ele]) continue;

						const descriptions = descriptionRows[i];
						row[recommendationsStruct][ele] = prediction[ele]
							.filter((e) => e.prediction !== undefined)
							.map((entry, idx) => {
								return {
									RecommendedFieldValue: entry.prediction,
									// == on purpose because prediction returns number as string but DB as number
									RecommendedFieldDescription:
										descriptions.find((descr) => descr[ele] == entry.prediction)?.[
											`SAP_Recommendations_Descr_${ele}`
										] ?? '',
									RecommendedFieldScoreValue: 0.5, //Number does not matter
									RecommendedFieldIsSuggestion: idx === 0
								};
							});
					}
				}
			}

			return response;
		})
	);
}

const matchRow = (row1, row2) =>
	(row1.ID !== undefined && row1.ID == row2.ID) ||
	(row1.SAP_RECOMMENDATIONS_ID !== undefined &&
		row1.SAP_RECOMMENDATIONS_ID == row2.SAP_RECOMMENDATIONS_ID);

function stringifyVals(ele) {
	if (typeof ele.val === 'number') {
		ele.val = String(ele.val);
	}
	if (ele.xpr) {
		ele.xpr = ele.xpr.map(stringifyVals);
	}
	return ele;
}
