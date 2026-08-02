import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

// eslint-disable-next-line import-x/no-default-export
export default [
    { ignores: ['**/dist', 'storage'] },
    ...apify,
    prettier,
    {
        // The scripts in bin/ are command line tools. Printing to stdout is their job,
        // and routing that through the Actor logger would defeat the point of having them.
        files: ['bin/**/*.js'],
        rules: { 'no-console': 'off' },
    },
];
