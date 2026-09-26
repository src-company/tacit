// Poseidon over BN254 (circomlib parameters) for the shielded pools: Merkle nodes (2), nullifiers (3), note keys
// and leaves (4), EdDSA challenges (5), and the EVM pool's spend message (7). Its own lazily-imported bundle, so
// the main vendor bundle and its pinned hash stay unchanged.
export { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
