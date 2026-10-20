# Bot training and testing for a new client (no code change)

1. **Account**: create the company (sign-up or super admin) and import its products (Products → Import).
2. **Training file**: copy `template.json` to `clients/<client>.json` and fill it:
   - `admin_email`: the company admin login
   - `bot`: name, tone (max 255 chars), greeting, about, opening hours (max 255), payment, `sells` (products / services / both)
   - `address_customers`: `auto` (Madam/Sir only when known), `madam_sir` (always Madam / Sir), `name` (first name only)
   - `delivery_zones`: `{ "area": "Colombo", "fee": 350, "days": "1-2 days" }`, `"*"` = everywhere; weight rules: `included_kg`, `per_extra_kg`
   - `services` (salons, clinics): name, price, duration_min
   - `policies`, `style_examples` (customer message → the reply the owner wants), `faqs` (keep all FAQs under ~6,000 chars)
   - `tests`: the client's own test cases (see below)
3. **Make and run the SQL** (safe to run again):
   ```
   node scripts/bot-training/make-training.mjs scripts/bot-training/clients/<client>.json > /tmp/<client>.sql
   psql "$PRODUCT_DATABASE_URL" -f /tmp/<client>.sql
   ```
4. **Test with marks** (`SALES_BOT_TEST_MODE=true` on the API while testing, then back to `false`):
   ```
   API_URL=http://localhost:6001/v1/api CLIENT_EMAIL=<admin email> CLIENT_PASSWORD='<password>' \
     node scripts/client-test.mjs scripts/bot-training/clients/<client>.json | tee client-test.log
   ```
   Standard checks come from the client's own products, FAQs and zones; then the `tests` from the JSON.
   Score: A ≥ 95 % ready · B ≥ 85 % fix the FAILs · C ≥ 70 % needs training · D not ready.
   Test orders / bookings are deleted at the end (`CLIENT_TEST_KEEP=1` keeps them).

A FAIL is usually fixed in the training file (an FAQ, a policy, a style example) – run steps 3 and 4 again.
Only a FAIL that happens for every shop is a code problem.

## Test case format
```json
{ "name": "delivery fee", "send": ["delivery kiyada?"],
  "expect": { "letters": "sinhala", "contains_any": ["350"], "contains_all": [], "not_contains": ["free"],
              "price": 350, "order": false, "photo": false } }
```
Each message in `send` is answered before the next one is sent. All `expect` keys are optional.

## Full project test
```
bash scripts/full-test.sh          # code tests: API jest + type check, bot pytest + guards, web type check, training files
bash scripts/full-test.sh --live   # + bot health, scale test (6 test shops), client test for every line in clients/.credentials
```
`clients/.credentials` (not in git): `chu-lk.json  owner@chu.lk  'password'` – one client per line.
Live tests need `SALES_BOT_TEST_MODE=true` on the API (restart), and `false` again afterwards.
