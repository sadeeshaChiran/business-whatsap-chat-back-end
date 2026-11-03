-- Moves every id sequence to at least MAX(id) + 1, never backwards.
-- Needed after restoring an Adminer dump (it does not save sequence positions); harmless otherwise.
DO $$
DECLARE r RECORD; mx BIGINT; cur BIGINT; called BOOLEAN;
BEGIN
  FOR r IN
    SELECT table_name AS tbl, column_name AS col,
           substring(column_default FROM 'nextval\(''([^'']+)''') AS seq
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM public.%I', r.col, r.tbl) INTO mx;
    EXECUTE format('SELECT last_value, is_called FROM %s', r.seq) INTO cur, called;
    IF (called AND mx >= cur) OR (NOT called AND mx >= cur) THEN
      PERFORM setval(r.seq, mx + 1, false);
    END IF;
  END LOOP;
END $$;
