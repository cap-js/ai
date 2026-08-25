import SQLiteService from '@cap-js/sqlite';

export default class AISQLiteService extends SQLiteService {
  init() {
    // add this.xyz here
    return super.init();
  }

  get factory() {
    const factory = super.factory;
    factory._create = factory.create;
    factory.create = async (tenant) => {
      const dbc = await factory._create(tenant);
      // add dbc.xyz here
      return dbc;
    };
    return factory;
  }

  static CQN2SQL = class CQN2AISQLite extends SQLiteService.CQN2SQL {
    // add cqn2sql stuff here
    static Functions = {
      ...SQLiteService.CQN2SQL.Functions
    };
  };
}
