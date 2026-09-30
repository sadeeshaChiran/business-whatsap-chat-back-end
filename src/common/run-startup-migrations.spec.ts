import { splitSqlStatements } from './run-startup-migrations';

describe('splitSqlStatements', () => {
  it('splits plain statements', () => {
    expect(splitSqlStatements("CREATE TABLE a (x int); INSERT INTO a VALUES (1);")).toEqual(['CREATE TABLE a (x int)', 'INSERT INTO a VALUES (1)']);
  });
  it('keeps semicolons inside quotes', () => {
    expect(splitSqlStatements("INSERT INTO a VALUES ('x;y'); SELECT 1")).toEqual(["INSERT INTO a VALUES ('x;y')", 'SELECT 1']);
  });
  it('keeps DO $$ … $$ blocks together', () => {
    const sql = "DO $$\nBEGIN\n  IF 1 = 1 THEN\n    UPDATE a SET x = 1;\n  END IF;\nEND $$;\nSELECT 2;";
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('UPDATE a SET x = 1;');
    expect(parts[0].endsWith('END $$')).toBe(true);
    expect(parts[1]).toBe('SELECT 2');
  });
  it('keeps tagged $f$ … $f$ bodies together', () => {
    expect(splitSqlStatements("CREATE FUNCTION f() RETURNS int AS $f$ SELECT 1; $f$ LANGUAGE sql; SELECT 3")).toHaveLength(2);
  });
});
