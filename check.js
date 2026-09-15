const m = require('./i18n/locales/manifest.json');
const v = m['stats.engagementTotalsBody'];
console.log('has real newline char:', v.includes(String.fromCharCode(10)));
console.log('length', v.length);
