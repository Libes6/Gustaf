Signed with a throwaway key made by `tauri signer generate` (password `testpass`); the secret key was
discarded. `signer.pub` is its public key, `other-signer.pub` another throwaway one. The `.sig` files come from
`tauri signer sign`, so they are the real format `latest.json` carries. Never use these keys for a release.
