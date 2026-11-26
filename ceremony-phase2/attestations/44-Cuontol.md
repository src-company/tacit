# Tacit Praxis ceremony: contribution #44

- **Contributor:** Cuontol (0x585433F045901c48403b259B4512582110B73E51)
- **Index:** phase2-44
- **Contribution hash:** `b3d7fc2bbec8c55ac16670f65b0b6cb4e123fc7207644a0e0fb4a02a986d1e38`
- **Built on:** phase2-43, sha256 `a0769bb629b7bf25f4c9e7d278612194112f81cd66a1a6ab6d1a320a613e5339`
- **Receipt:** `receipt-44.json`, signed by coordinator key `c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7`

## Tool

- **Commit:** `01dae294cbe95ec02c5543e1633597fc6a958d0e`
- **Binary:** release binary `tacit-ceremony-linux-amd64`, sha256 `89026fa99c125017d89f21e99652264134903b505b410d6287381c09f2e26938`
- **`tacit-ceremony version`:** `tacit-ceremony go1.27.4 GOARCH=amd64 GOOS=linux vcs.revision=01dae294cbe95ec02c5543e1633597fc6a958d0e vcs.modified=false`

## Machine

- **Hardware:** cloud VPS instance, 4 vCPU Intel Xeon Platinum 8370C @ 2.80GHz, 54 GB RAM
- **OS:** Ubuntu 22.04.5 LTS (Linux 6.8.0-1063-azure x86_64)
- **Network during the contribution:** online through the coordinator

## Randomness and its disposal

- **Source:** the tool's own (Go crypto/rand, from the OS)
- **Swap / hibernation:** off (no swap configured)
- **Afterwards:** process exited normally; randomness discarded when it exited; instance still running for other work, disk not wiped
- **Anything else:** VPS owned by the contributor, SSH-key access only

## Signature

The lines above, signed with a key that is already public and linked to you:

- **Method:** Ethereum (0x585433F045901c48403b259B4512582110B73E51, EIP-191)
- **Signature:**

```
70f06e47af802ff9283e8c9a45895e4788b7629b59d7e8ef90fe728e29c78e9f482395654dccc7c20128a63da6042f583ab5e428d5ca4e471bc8689a95dd02481b
```
