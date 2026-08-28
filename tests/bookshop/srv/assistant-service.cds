using {sap.capire.bookshop as my} from '../db/schema';

@agent
service AssistantService {
  @readonly entity Books   as projection on my.Books { ID, title, descr, stock, price, author };
  @readonly entity Authors as projection on my.Authors { ID, name };
}
