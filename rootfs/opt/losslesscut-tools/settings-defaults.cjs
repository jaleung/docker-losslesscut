// Default LosslessCut settings of this image (/defaults/losslesscut-settings.json),
// applied with LosslessCut's --settings-json at launch.
//
// A setting is only applied when the user hasn't changed it: it's missing from
// LosslessCut's config, or still has LosslessCut's own default value.
//
// Usage (with LosslessCut's Electron as Node.js):
//   ELECTRON_RUN_AS_NODE=1 /LosslessCut/losslesscut settings-defaults.cjs CONFIG_JSON DEFAULTS_JSON
// Prints the settings to apply as JSON ({} when there's nothing to apply).

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

// LosslessCut's own defaults for the settings managed here (src/main/configStore.ts)
const losslessCutDefaults = {
  outSegTemplate: undefined,
  mergedFileTemplate: undefined,
  mergedFilesTemplate: undefined,
  cleanupChoices: { trashTmpFiles: true, askForCleanup: true, closeFile: true, cleanupAfterExport: false },
};

const [configPath, defaultsPath] = process.argv.slice(2);

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  // No config yet (first start) or unreadable: apply all defaults
}

const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));

const toApply = {};
for (const [key, value] of Object.entries(defaults)) {
  const current = config[key];
  if (current == null || isDeepStrictEqual(current, losslessCutDefaults[key])) {
    toApply[key] = value;
  }
}

process.stdout.write(JSON.stringify(toApply));
