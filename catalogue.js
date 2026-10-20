/* TradeBond catalogue: the only source of products and prices. Shared by the browser (sim.js) and the server.
   The AI may pick products and quantities from this list; prices always come from here. Fictional seller. */
(function (root) {
  'use strict';
  const CATALOGUE = [
    { key: 'battery', pattern: 'batter(?:y|ies)(?:\\s+packs?)?', product: 'Lithium battery pack 5kWh (UN3480)', hs: '8507.60', unit: 'packs', noun: 'battery packs', price: 4000 },
    { key: 'inverter', pattern: 'inverters?', product: 'Hybrid inverter 10kW', hs: '8504.40', unit: 'pcs', noun: 'inverters', price: 6000 },
    { key: 'solar', pattern: 'solar(?:\\s+panels?)?|panels?', product: 'Solar panel 550W', hs: '8541.43', unit: 'pcs', noun: 'solar panels', price: 400 },
    { key: 'mount', pattern: 'mounting(?:\\s+kits?)?|kits?', product: 'Aluminium mounting kit', hs: '7610.90', unit: 'kits', noun: 'mounting kits', price: 900 },
    { key: 'cable', pattern: 'cabl(?:e|es|ing)', product: 'PV cabling, 100 m roll', hs: '8544.49', unit: 'rolls', noun: 'cable rolls', price: 120 },
  ];
  const SELLERS = [{ key: 'sunray', name: 'Sunray', company: 'Shenzhen Sunray Energy Demo Co., Ltd. (fictional)' }];
  const api = { CATALOGUE, SELLERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.catalogue = api; }
})(typeof window !== 'undefined' ? window : globalThis);
