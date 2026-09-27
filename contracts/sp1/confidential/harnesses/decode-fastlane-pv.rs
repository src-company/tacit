// One-off: decode a fastlane settle's public_values.hex against the exact ConfidentialPool.PublicValues
// ABI shape (copied verbatim from contracts/sp1/confidential/src/main.rs) and print the fields relevant
// to a pre-submission sanity check, rather than trusting a hand-computed byte offset.
use alloy_sol_types::{sol, SolValue};

sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; uint256 cutA; uint256 cutB; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct CdpLeg { bytes32 asset; uint256 value; }
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; uint256 rateSnapshot; CdpLeg[] legs; bytes32 owner; }
    struct CdpClose { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpLiquidate { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpTopup { address controller; uint256 debtValue; uint256 rateSnapshot; bytes32 oldPositionNullifier; bytes32 newPositionLeaf; CdpLeg[] oldLegs; CdpLeg[] newLegs; }
    struct CbtcMint { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;
        bytes32[] nullifiers;
        bytes32[] leaves;
        bytes32[] depositsConsumed;
        Withdrawal[] withdrawals;
        FeePayment[] fees;
        bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts;
        bytes32[] bitcoinRootsUsed;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        SwapSettlement[] swaps;
        LpSettlement[] liquidity;
        uint64 deadline;
        bytes32 lockSetRoot;
        bytes32[] lockLeaves;
        bytes32[] lockNullifiers;
        bytes32[] adaptorClaimS;
        uint64 refundNotBefore;
        bytes32 cdpPositionRoot;
        CdpMint[] cdpMints;
        CdpClose[] cdpCloses;
        CdpLiquidate[] cdpLiquidations;
        CdpTopup[] cdpTopups;
        CbtcMint[] cbtcMints;
        bytes32 memoRoot;
        bytes32[] bitcoinConsumedSources;
        bytes32[] bitcoinBurnIdsConsumed;
        bytes32[] harvestActionIds;
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: decode-fastlane-pv <public_values.hex path>");
    let hexstr = std::fs::read_to_string(&path).unwrap();
    let bytes = hex::decode(hexstr.trim().trim_start_matches("0x")).unwrap();
    let pv = PublicValues::abi_decode(&bytes, true).expect("abi_decode failed");
    println!("version: {}", pv.version);
    println!("chainBinding: 0x{}", hex::encode(pv.chainBinding));
    println!("spendRoot: 0x{}", hex::encode(pv.spendRoot));
    println!("nullifiers: {:?}", pv.nullifiers.iter().map(|n| format!("0x{}", hex::encode(n))).collect::<Vec<_>>());
    println!("leaves: {:?}", pv.leaves.iter().map(|n| format!("0x{}", hex::encode(n))).collect::<Vec<_>>());
    println!("bitcoinSpentRoot: 0x{}", hex::encode(pv.bitcoinSpentRoot));
    println!("bitcoinConsumedSources: {:?}", pv.bitcoinConsumedSources.iter().map(|n| format!("0x{}", hex::encode(n))).collect::<Vec<_>>());
    println!("memoRoot: 0x{}", hex::encode(pv.memoRoot));
    println!("withdrawals.len: {}", pv.withdrawals.len());
    println!("fees.len: {}", pv.fees.len());
    println!("crossOuts.len: {}", pv.crossOuts.len());
    println!("lockLeaves.len: {}", pv.lockLeaves.len());
}
