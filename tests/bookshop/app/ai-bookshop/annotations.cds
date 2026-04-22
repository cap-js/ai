using CatalogService as service from '../../srv/cat-service';
using from '@sap/cds/common';

annotate service.Books with @(
  Common.SemanticKey: [ID],
  Capabilities.NavigationRestrictions: {RestrictedProperties: [{
    NavigationProperty: DraftAdministrativeData,
    FilterRestrictions: {Filterable: false,
    },
  }, ], },
  UI.HeaderInfo: {
    TypeName: '{i18n>BOOK}',
    TypeNamePlural: '{i18n>BOOKS}',
    Title: {Value: {$edmJson: {
      $Apply: [
        {$Path: 'title',
        },
        ' (',
        {$Path: 'ID',
        },
        ')',
      ],
      $Function: 'odata.concat',
    }, }, },
    Description: {Value: genre_ID},
    Image: image
  },
  UI.SelectionFields: [
    author_ID,
    genre_ID,
    currency_code,
    stock
  ],
  UI.LineItem: [
    {Value: ID, },
    {Value: title},
    {Value: author_ID, },
  ],
  UI.HeaderFacets: [
    {
      $Type: 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#author',
    },
    {
      $Type: 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#price',
    },
    {
      $Type: 'UI.ReferenceFacet',
      Target: '@UI.DataPoint#stock',
    },
  ]
);

annotate service.Books with @(
  UI.DataPoint #author: {
    Title: '{i18n>Author}',
    Value: author_ID,
  },
  UI.DataPoint #stock: {
    Title: '{i18n>Stock}',
    Value: stock,
  },
  UI.DataPoint #price: {
    Title: '{i18n>Price}',
    Value: price,
  },
  UI.FieldGroup #EditMode: {
    $Type: 'UI.FieldGroupType',
    Data: [
      {Value: title, },
      {Value: author_ID, },
      {Value: genre_ID, },
      {Value: stock, },
      {Value: price, },
      {Value: currency_code, },
      {Value: image, },
    ],
  },
  UI.Facets: [{
    $Type: 'UI.ReferenceFacet',
    ID: 'BOOK_DETAILS',
    Label: '{i18n>BOOK_DETAILS}',
    Target: '@UI.FieldGroup#EditMode',
    @UI.Hidden: IsActiveEntity,
  }]
);

annotate service.Chapters with @(UI.LineItem: [
  {
    $Type: 'UI.DataField',
    Label: 'Title (Recommendations Input)',
    Value: title,
  },
  {
    $Type: 'UI.DataField',
    Label: 'Genre (Recommendations Output)',
    Value: genre_ID,
  },
  {
    $Type: 'UI.DataField',
    Label: 'Page count (Recommendations Output)',
    Value: pageCount,
  },
  {
    $Type: 'UI.DataField',
    Label: '1..n column',
    Value: details.text,
  },
  {
    $Type: 'UI.DataFieldForAction',
    Label: 'Accpet',
    Criticality: #Positive,
    Action: 'CatalogService.accept',
    Inline: true,
  }
]);

annotate service.Currencies with @(
  UI.LineItem #tableView: [
    {
      $Type: 'UI.DataField',
      Value: code,
    },
    {
      $Type: 'UI.DataField',
      Value: descr,
    },
    {
      $Type: 'UI.DataField',
      Value: name,
    },
  ],
  UI.SelectionPresentationVariant #tableView: {
    $Type: 'UI.SelectionPresentationVariantType',
    PresentationVariant: {
      $Type: 'UI.PresentationVariantType',
      Visualizations: ['@UI.LineItem#tableView',
      ],
    },
    SelectionVariant: {
      $Type: 'UI.SelectionVariantType',
      SelectOptions: [],
    },
    Text: 'Table View Currencies',
  }
);

// context test123 {
//     entity NewTable {
//         key ID: UUID;
//         abc: String;
//         def: String;
//     }

//     entity NewTable2 {
//         key ID: UUID;
//         abc: String;
//     }
// }
