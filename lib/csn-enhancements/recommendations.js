const enhancedFlag = 'sap.cds.recommendations';

function enhanceModel(model) {
  if (model.meta.flavor !== 'inferred' || model.meta[enhancedFlag]) return;

  for (const name in model.definitions) {
    const entity = model.definitions[name];
    if (!entity['@odata.draft.enabled']) {
      continue;
    }
    enhanceEntity(name, model);
    if (entity.compositions) {
      for (const comp in entity.compositions) {
        enhanceEntity(entity.compositions[comp].target, model);
      }
    }
  }
  model.meta[enhancedFlag] = true;
}

/**
 *
 * @param {string} name Name of entity
 * @param {CSN} model
 */
function enhanceEntity(name, model) {
  const entity = model.definitions[name];
  if (entity['@UI.Recommendations']) return; // already enhanced
  const vhFields = Object.keys(entity.elements).reduce((vhFields, ele) => {
    // If the property has a value help
    if (
      entity.elements[ele]['@UI.RecommendationState'] !== 0 &&
      (entity.elements[ele]['@Common.ValueList.CollectionPath'] ||
        model.definitions[entity.elements[ele].target]?.['@cds.odata.valuelist'])
    ) {
      if (entity.elements[ele].keys) {
        for (const key of entity.elements[ele].keys) {
          vhFields[ele + '_' + key.ref.join('_')] = structuredClone(
            model.definitions[entity.elements[ele].target].elements[key.ref]
          );
          delete vhFields[ele + '_' + key.ref.join('_')].key;
        }
      } else if (!entity.elements[ele].on) {
        vhFields[ele] = structuredClone(entity.elements[ele]);
        delete vhFields[ele].key;
      }
    }
    return vhFields;
  }, {});
  if (Object.keys(vhFields).length > 0) {
    entity.elements['SAP_Recommendations'] = {
      type: 'cds.Association',
      cardinality: { max: 1 },
      on: [{ val: 1 }, '=', { val: 1 }],
      target: name + '_Recommendations'
    };
    const cqn = entity.projection ?? entity.query.SELECT;
    cqn.columns ??= ['*'];
    cqn.columns.push({
      cast: {
        type: 'cds.Association',
        cardinality: { max: 1 },
        on: [{ val: 1 }, '=', { val: 1 }],
        target: name + '_Recommendations'
      },
      as: 'SAP_Recommendations'
    });
    entity['@UI.Recommendations'] = { '=': 'SAP_Recommendations' };
    model.definitions[name + '_Recommendations'] = {
      kind: 'entity',
      '@cds.persistence.skip': true,
      elements: Object.keys(vhFields).reduce(
        (acc, fieldWithRecommendations) => {
          acc[fieldWithRecommendations] = {
            virtual: true,
            items: {
              elements: {
                RecommendedFieldValue: vhFields[fieldWithRecommendations],
                RecommendedFieldDescription: { type: 'cds.String' },
                RecommendedFieldScoreValue: { type: 'cds.Decimal' },
                RecommendedFieldIsSuggestion: { type: 'cds.Boolean' }
              }
            }
          };
          return acc;
        },
        { technicalRecommendationsIdentifier: { key: true, type: 'cds.UUID' } }
      )
    };
  }
}

export default enhanceModel;
