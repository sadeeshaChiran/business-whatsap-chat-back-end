/**
 * Lists every API route with its protection (login, roles, super admin, package feature).
 * Reads the compiled app in dist/ – run `npm run build` first.
 *   node scripts/list-routes.js            → table
 *   node scripts/list-routes.js --json     → JSON (used by the security tests)
 */
require('reflect-metadata');
const fs = require('fs');
const path = require('path');

process.env.PRODUCT_DATABASE_URL = process.env.PRODUCT_DATABASE_URL || 'postgresql://unused@localhost/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-listing-only-route-listing-only';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const dist = path.join(__dirname, '..', 'dist');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.spec.js') && !full.includes(`${path.sep}main.js`)) files.push(full);
  }
})(dist);

const guardNames = (target) => (Reflect.getMetadata('__guards__', target) || []).map((g) => g.name || String(g));
const routes = [];
const seen = new Set();
for (const file of files) {
  let mod;
  try { mod = require(file); } catch { continue; }
  for (const exported of Object.values(mod)) {
    if (typeof exported !== 'function' || seen.has(exported)) continue;
    const ctrlPath = Reflect.getMetadata('path', exported);
    if (ctrlPath === undefined || !Reflect.getMetadata('__controller__', exported)) continue;
    seen.add(exported);
    const classGuards = guardNames(exported);
    const classRoles = Reflect.getMetadata('agent_metra_roles', exported);
    const classFeature = Reflect.getMetadata('agent_metra_features', exported);
    const classSkip = Reflect.getMetadata('THROTTLER:SKIPdefault', exported);
    for (const name of Object.getOwnPropertyNames(exported.prototype)) {
      if (name === 'constructor') continue;
      const handler = exported.prototype[name];
      if (typeof handler !== 'function') continue;
      const methodPath = Reflect.getMetadata('path', handler);
      const method = Reflect.getMetadata('method', handler);
      if (methodPath === undefined || method === undefined) continue;
      const guards = [...classGuards, ...guardNames(handler)];
      const roles = Reflect.getMetadata('agent_metra_roles', handler) || classRoles || null;
      const feature = Reflect.getMetadata('agent_metra_features', handler) || classFeature || null;
      const join = (...parts) => '/' + parts.flatMap((p) => String(p || '').split('/')).filter(Boolean).join('/');
      routes.push({
        method: METHODS[method],
        path: join('v1/api', ctrlPath, methodPath),
        controller: exported.name,
        handler: name,
        auth: guards.includes('JwtAuthGuard'),
        super_admin: guards.includes('SuperAdminGuard'),
        roles,
        feature: feature ? `${feature.mode}:${feature.keys.join(',')}` : null,
        throttle_skipped: Boolean(Reflect.getMetadata('THROTTLER:SKIPdefault', handler) || classSkip),
      });
    }
  }
}
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(routes, null, 2));
} else {
  for (const r of routes) {
    const access = r.super_admin ? 'super admin' : r.roles ? r.roles.join('/') : r.auth ? 'any member' : 'PUBLIC';
    console.log(`${r.method.padEnd(6)} ${r.path.padEnd(70)} ${access}${r.feature ? `  [${r.feature}]` : ''}`);
  }
  console.log(`\n${routes.length} routes`);
}
