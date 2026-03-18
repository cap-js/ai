using {sap.capire.bookshop as my} from '../db/schema';

service CatalogService {

  /**
   * For displaying lists of Books
   */
  @cds.redirection.target
  @title: 'ABC'
  @odata.draft.enabled
  entity Books                as projection on my.Books;

  @odata.draft.enabled
  entity BooksWithComposedKey as projection on my.BooksWithComposedKey;

  @odata.draft.enabled
  entity BooksWithCustomKey   as projection on my.BooksWithCustomKey;

  entity Authors              as
    select from my.Authors
    excluding {
      books
    };

  entity Chapters             as projection on my.Chapters
    actions {
      @(Common.SideEffects: {TargetEntities: [in.book.chapters]})
      action accept();
    };


  @EnterpriseSearch.model: true
  @EnterpriseSearch.resultItemKey: ['ID']
  @EnterpriseSearch.title: {titleField: 'title'}
  @EnterpriseSearch.modelName: '{i18n>BOOK}'
  @EnterpriseSearch.modelNamePlural: '{i18n>BOOKS}'
  @Consumption.semanticObject: 'Books'
  @Consumption.action: 'Manage'
  @Consumption.semanticObjectAction: 'Manage'
  entity ListOfBooks          as
    projection on my.Books {
      ID,
      title,
      author.name as authorName @(title: 'Author')
    };

  annotate ListOfBooks with {
    ID;
    @EnterpriseSearch.freeStyleField: {
      importance: #HIGH,
      withAutoCompletion: true
    }
    @EnterpriseSearch.responseField.standard: {displayPosition: 1}
    @Search.fuzzinessThreshold: 0.77
    @EnterpriseSearch.searchOptions: 'similarCalculationMode=substringsearch'
    title;
    @EnterpriseSearch.freeStyleField: {importance: #HIGH}
    @EnterpriseSearch.responseField.standard: {displayPosition: 2}
    @Search.fuzzinessThreshold: 0.77
    @EnterpriseSearch.searchOptions: 'similarCalculationMode=substringsearch'
    @EnterpriseSearch.filteringFacet: {
      default,
      displayPosition: 3
    }
    authorName;
  };

  @requires: 'authenticated-user'
  action submitOrder(book: Books:ID, quantity: Integer) returns {
    stock : Integer
  };

  event OrderedBook : {
    book     : Books:ID;
    quantity : Integer;
    buyer    : String
  };

  @requires: 'authenticated-user'
  action callProcedure();
}
