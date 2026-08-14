# Test fixtures — byte-exact official package files

These gzipped files are the exact published contents of the packages dsh-resume
patches, fetched from the npm registry (`npm pack <pkg>@0.1.0-rc.6`, extracted
`package/<file>`), gzipped at level 9 so the suite stays small. They let the
tests verify the version guard and byte-exact patch/restore roundtrip against
REAL official content without installing the packages (npm cannot install in
this repo: its runtime dependency ranges like `^0.1.0` match no published
version — all @deepseek-ai packages publish rc prereleases).

SHA-256 of the ORIGINAL unpacked files:

- `@deepseek-ai/dsh-agent-loop/lib/index.js` (47416 bytes): `bf8ca1e9b05e9b78320a5e2f0b4e25395eba91dd72db6d3cb5626e3dfb529204`
- `@deepseek-ai/dsh-session/lib/index.js` (79221 bytes): `9270186b579bc8a4c6c53c256e4471d3f134e94308462c6a413a722e9c7556fb`
- `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` (426514 bytes): `0f7927e6284159b9b4138df50a1d64755e6e3ff76064bb06309678392530a829`
