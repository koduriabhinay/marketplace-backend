import { closeDb, resetDb } from './db';

beforeEach(resetDb);
afterAll(closeDb);
