module.exports = {
  preset: 'react-native',
  // @noble/ciphers ships ESM only; let Babel transform it (default RN pattern
  // ignores all of node_modules except the RN packages).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
};
