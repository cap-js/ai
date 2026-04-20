using {
  managed,
  cuid,
  sap
} from '@sap/cds/common';
using {Currency} from '@sap/cds-common-content';

namespace sap.capire.bookshop;

entity Books : managed {
  key ID                            : Integer @title: '{i18n>ID}';

      @mandatory
      title                         : String(20) @title: '{i18n>Title}';


      descr                         : String(1111) @title: '{i18n>DESCR}';


      @Search.fuzzinessThreshold: 0.5
      defaultDescr                  : String(1111);

      @mandatory author             : Association to Authors  @title: '{i18n>AUTHOR}'  @Common.Text: author.name  @Common.TextArrangement: #TextFirst  @Common.ValueList: {
                                        CollectionPath: 'Authors',
                                        Parameters: [{
                                          $Type: 'Common.ValueListParameterInOut',
                                          LocalDataProperty: author_ID,
                                          ValueListProperty: 'ID',
                                        }, ],
                                      };
      genre                         : Association to Genres  @Common.Text: genre.name  @Common.TextArrangement: #TextFirst  @title: '{i18n>GENRE}'  @Common.ValueListWithFixedValues  @Common.ValueList: {
                                        CollectionPath: 'Genres',
                                        Parameters: [{
                                          $Type: 'Common.ValueListParameterInOut',
                                          LocalDataProperty: genre_ID,
                                          ValueListProperty: 'ID',
                                        }, ]
                                      };
      details                       : Composition of one BookDetails
                                        on details.book = $self;
      stock                         : Integer @title: '{i18n>Stock}';
      price                         : Decimal(6, 2) @title: '{i18n>Price}';
      currency                      : Currency  @Common.ValueListWithFixedValues  @title: '{i18n>Currency}';
      chapters                      : Composition of many Chapters
                                        on chapters.book = $self;
      image                         : LargeBinary @Core.MediaType: 'image/png';

      @cds.api.ignore
      embedding                     : Vector;

      authorWORecommendations       : Association to Authors  @title: 'Author without field recommendations'  @Common.Text: author.name  @Common.TextArrangement: #TextFirst  @Common.ValueList: {
                                        CollectionPath: 'Authors',
                                        Parameters: [{
                                          $Type: 'Common.ValueListParameterInOut',
                                          LocalDataProperty: authorWORecommendations_ID,
                                          ValueListProperty: 'ID',
                                        }, ],
                                      }  @UI.RecommendationState: 0;
      authorWDynamicRecommendations : Association to Authors  @title: 'Author with dynamic field recommendations enablement'  @Common.Text: author.name  @Common.TextArrangement: #TextFirst  @Common.ValueList: {
                                        CollectionPath: 'Authors',
                                        Parameters: [{
                                          $Type: 'Common.ValueListParameterInOut',
                                          LocalDataProperty: authorWDynamicRecommendations_ID,
                                          ValueListProperty: 'ID',
                                        }, ],
                                      }  @UI.RecommendationState : (genre.name = 'Fantasy' ? 0 : 1);
}

entity BookDetails : cuid {
  book   : Association to one Books;
  field1 : String;
}

@assert.unique: {uniqueTitles: [
  book,
  title
]}
@assert.unique: {uniqueGenres: [
  book,
  genre
]}
entity Chapters : cuid {
  book      : Association to one Books @UI.Hidden;
  title     : String @title: 'Title';
  abstract  : String @title: 'Abstract';
  pageCount : Integer @title: 'Page count (INT)';
  genre     : Association to Genres  @title: 'Genre'  @Common.ValueListWithFixedValues  @Common.Text: genre.name  @Common.TextArrangement: #TextOnly;
  details   : Composition of many ChapterDetails
                on details.chapter = $self;
}

entity ChapterDetails : cuid {
  chapter : Association to one Chapters @UI.Hidden;
  text    : String;
}

entity Authors : managed {
  key ID              : Integer  @title: '{i18n>AUTHOR}'  @Common.Text: name  @Common.TextArrangement: #TextFirst;
      @mandatory name : String(30);
      dateOfBirth     : Date;
      dateOfDeath     : Date;
      placeOfBirth    : String;
      placeOfDeath    : String;
      books           : Association to many Books
                          on books.author = $self;
}

/**
 * Hierarchically organized Code List for Genres
 */
entity Genres : sap.common.CodeList {
  key ID       : Integer  @Common.Text: name  @Common.TextArrangement: #TextFirst;
      parent   : Association to Genres;
      children : Composition of many Genres
                   on children.parent = $self;
}


entity BooksWithCustomKey : managed {
  key notID    : Integer;
      title    : String(20);
      descr    : String(1111);
      author   : Association to Authors  @Common.Text: author.name  @Common.TextArrangement: #TextFirst  @Common.ValueList: {
                   CollectionPath: 'Authors',
                   Parameters: [{
                     $Type: 'Common.ValueListParameterInOut',
                     LocalDataProperty: author_ID,
                     ValueListProperty: 'ID',
                   }, ],
                 };
      stock    : Integer;
      price    : Decimal(6, 2);
      currency : Currency;
}

entity BooksWithComposedKey : managed {
  key key1     : Integer;
  key key2     : Integer;
      title    : String(40);
      descr    : String(1111);
      author   : Association to Authors  @Common.Text: author.name  @Common.TextArrangement: #TextFirst  @Common.ValueList: {
                   CollectionPath: 'Authors',
                   Parameters: [{
                     $Type: 'Common.ValueListParameterInOut',
                     LocalDataProperty: author_ID,
                     ValueListProperty: 'ID',
                   }, ],
                 };
      stock    : Integer;
      price    : Decimal(6, 2);
      currency : Currency;
}
