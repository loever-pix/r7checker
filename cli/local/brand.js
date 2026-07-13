'use strict';
// Build-time brand. The build script bakes `process.env.R6_BRAND` via esbuild
// --define, so ONE codebase produces two exes from the same source:
//
//   R6Checker   — full bulk checker (login + ranks + skins + ban + last-played)
//   Ubisoft VM  — lite login validator (login via sessions + ban only; outputs
//                 valid / invalid / 2fa / banned, no item/rank/skin enrichment)
//
// Run under `node` (dev) with no R6_BRAND → full R6Checker. Build the VM with
// `R6_BRAND=ubivm node build-local.js`.

const ID = (process.env.R6_BRAND || 'r6checker').toLowerCase();

const BRANDS = {
  r6checker: {
    id: 'r6checker',
    name: 'R6CHECKER',                       // splash word-mark
    title: 'R6Checker',                      // window title / banners
    subtitle: 'desktop bulk checker',
    exe: 'R6Checker',
    lite: false,
  },
  ubivm: {
    id: 'ubivm',
    name: 'UBISOFT VM',
    title: 'Ubisoft VM',
    subtitle: 'login validator  ·  valid · invalid · 2fa · banned',
    exe: 'UbisoftVM',
    lite: true,
  },
};

module.exports = BRANDS[ID] || BRANDS.r6checker;
