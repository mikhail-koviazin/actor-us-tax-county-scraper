import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

// eslint-disable-next-line import-x/no-default-export
export default [
    { ignores: ['**/dist', 'storage'] },
    ...apify,
    prettier,
    {
        // The scripts in bin/ and scripts/ are command line tools. Printing to stdout is their job,
        // and routing that through the Actor logger would defeat the point of having them.
        // They are also development tooling that never ships inside the image the platform runs,
        // so reaching for a devDependency is correct there and only there.
        files: ['bin/**/*.js', 'scripts/**/*.mjs'],
        rules: { 'no-console': 'off', 'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }] },
    },
];
