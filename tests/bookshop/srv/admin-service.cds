using {sap.capire.bookshop as my} from '../db/schema';

service AdminService @(requires: 'authenticated-user') {
  @cds.redirection.target
  entity Books                    as projection on my.Books;

  entity Authors                  as projection on my.Authors;

  entity BooksWithVectorFunctions as
    projection on Books {
      *,
      (
        VECTOR_EMBEDDING(
          descr, 'QUERY', 'SAP_GXY.20250407'
        )
      ) as VECTOR_EMBEDDING_COLUMN  : Vector,
      (
        COSINE_SIMILARITY(
          embedding, VECTOR_EMBEDDING(
            title, 'QUERY', 'SAP_GXY.20250407'
          )
        )
      ) as COSINE_SIMILARITY_COLUMN : Decimal,
      (
        l2distance(
          embedding, VECTOR_EMBEDDING(
            title, 'QUERY', 'SAP_GXY.20250407'
          )
        )
      ) as L2_DISTANCE_COLUMN       : Decimal,
      (
        CARDINALITY(embedding)
      ) as CARDINALITY_COLUMN       : Decimal
    }
}
