//! Mines CreateX CREATE2 salts whose contract address starts with zero bytes.
//!
//! CreateX.deployCreate2(salt, initCode) with a salt whose first 20 bytes are zero and whose 21st byte is 0x01 is the
//! chain-bound form: any caller, one chain, guarded as keccak256(abi.encode(chainId, salt)). The address is then
//!   CREATE2(CreateX, keccak256(abi.encode(chainId, salt)), keccak256(initCode))
//! so it commits to the exact init code (constructor arguments included): only that code can land there, and only
//! on that chain.
//!
//!   (add --create3 to mine CreateX deployCreate3 salts: the address then does not depend on the init code, so --init-hash is not needed)
//!   (add --deployer 0x.. to bind the salt to one caller: only that address can deploy with it, which CREATE3 needs, since its address does not pin the code)
//!   vanity-create2 mine --factory 0x.. --init-hash 0x.. [--chain-id 1] --zeros 3 --tag NAME
//!   vanity-create2 address --factory 0x.. --init-hash 0x.. [--chain-id 1] --salt 0x..
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tiny_keccak::{Hasher, Keccak};

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

struct Ctx {
    factory: [u8; 20],
    init_hash: [u8; 32],
    chain_id: u64,
    create3: bool,
    deployer: Option<[u8; 20]>,   // Some: the salt is bound to this caller too (CreateX permissioned form), so nobody else can use it
}

// keccak256 of CreateX's CREATE3 proxy init code (hex"67363d3d37363d34f03d5260086018f3")
const PROXY_INIT_HASH: [u8; 32] = [
    0x21, 0xc3, 0x5d, 0xbe, 0x1b, 0x34, 0x4a, 0x24, 0x88, 0xcf, 0x33, 0x21, 0xd6, 0xce, 0x54, 0x2f, 0x8e, 0x9f, 0x30, 0x55,
    0x44, 0xff, 0x09, 0xe4, 0x99, 0x3a, 0x62, 0x31, 0x9a, 0x49, 0x7c, 0x1f,
];

fn address_of(c: &Ctx, salt: &[u8; 32]) -> [u8; 20] {
    let guarded = match &c.deployer {
        // keccak256(abi.encode(msg.sender, block.chainid, salt))
        Some(d) => {
            let mut g = [0u8; 96];
            g[12..32].copy_from_slice(d);
            g[56..64].copy_from_slice(&c.chain_id.to_be_bytes());
            g[64..].copy_from_slice(salt);
            keccak(&g)
        }
        None => {
            let mut g = [0u8; 64];
            g[24..32].copy_from_slice(&c.chain_id.to_be_bytes());
            g[32..].copy_from_slice(salt);
            keccak(&g)
        }
    };
    let mut p = [0u8; 85];
    p[0] = 0xff;
    p[1..21].copy_from_slice(&c.factory);
    p[21..53].copy_from_slice(&guarded);
    p[53..85].copy_from_slice(if c.create3 { &PROXY_INIT_HASH } else { &c.init_hash });
    let h = keccak(&p);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[12..32]);
    if c.create3 {
        // CREATE3: the contract is the proxy's first CREATE, keccak256(rlp([proxy, 1])), so it does not depend on the init code
        let mut r = [0u8; 23];
        r[0] = 0xd6;
        r[1] = 0x94;
        r[2..22].copy_from_slice(&out);
        r[22] = 0x01;
        let h2 = keccak(&r);
        out.copy_from_slice(&h2[12..32]);
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn parse_hex<const N: usize>(s: &str) -> [u8; N] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert!(s.len() == N * 2, "expected {} hex bytes, got {}", N, s.len() / 2);
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("bad hex");
    }
    out
}

fn checksum(a: &[u8; 20]) -> String {
    let lower = hex(a);
    let h = hex(&keccak(lower.as_bytes()));
    let mut out = String::from("0x");
    for (i, ch) in lower.chars().enumerate() {
        let nib = u8::from_str_radix(&h[i..i + 1], 16).unwrap();
        out.push(if ch.is_ascii_alphabetic() && nib >= 8 { ch.to_ascii_uppercase() } else { ch });
    }
    out
}

// Every salt starts with 20 zero bytes and the flag 0x01; the next bytes name the worker and the last 8 count up from
// a random start.
fn mine(c: &Ctx, zeros: usize) -> ([u8; 32], [u8; 20], u64) {
    let found = AtomicBool::new(false);
    let tries = AtomicU64::new(0);
    let result: Mutex<Option<([u8; 32], [u8; 20])>> = Mutex::new(None);
    let workers = rayon::current_num_threads();
    let mut seed = [0u8; 8];
    getrandom::getrandom(&mut seed).expect("no randomness");
    let base = u64::from_be_bytes(seed);
    (0..workers).into_par_iter().for_each(|w| {
        let mut salt = [0u8; 32];
        if let Some(d) = &c.deployer {
            salt[..20].copy_from_slice(d);
        }
        salt[20] = 0x01;
        salt[21] = (w >> 8) as u8;
        salt[22] = w as u8;
        let mut n = base;
        let mut local = 0u64;
        while !found.load(Ordering::Relaxed) {
            salt[24..32].copy_from_slice(&n.to_be_bytes());
            n = n.wrapping_add(1);
            local += 1;
            let a = address_of(c, &salt);
            if a[..zeros].iter().all(|b| *b == 0) {
                if !found.swap(true, Ordering::SeqCst) {
                    *result.lock().unwrap() = Some((salt, a));
                }
                break;
            }
            if local % 65536 == 0 {
                tries.fetch_add(65536, Ordering::Relaxed);
                local = 0;
            }
        }
        tries.fetch_add(local, Ordering::Relaxed);
    });
    let (salt, a) = result.into_inner().unwrap().expect("no result");
    (salt, a, tries.load(Ordering::Relaxed))
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).map(|i| args[i + 1].clone())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let c = Ctx {
        factory: parse_hex(&arg(&args, "--factory").expect("--factory")),
        init_hash: if args.iter().any(|a| a == "--create3") { [0u8; 32] } else { parse_hex(&arg(&args, "--init-hash").expect("--init-hash")) },
        create3: args.iter().any(|a| a == "--create3"),
        deployer: arg(&args, "--deployer").map(|d| parse_hex(&d)),
        chain_id: arg(&args, "--chain-id").unwrap_or("1".into()).parse().unwrap(),
    };
    match cmd {
        "address" => {
            let salt: [u8; 32] = parse_hex(&arg(&args, "--salt").expect("--salt"));
            println!("{}", checksum(&address_of(&c, &salt)));
        }
        "mine" => {
            let zeros: usize = arg(&args, "--zeros").unwrap_or("3".into()).parse().unwrap();
            let tag = arg(&args, "--tag").expect("--tag");
            let t = Instant::now();
            let (salt, a, tries) = mine(&c, zeros);
            let secs = t.elapsed().as_secs_f64();
            eprintln!("{:<22} {} after {} tries in {:.1}s ({:.1}M/s)", tag, checksum(&a), tries, secs, tries as f64 / secs / 1e6);
            println!("{{ \"salt\": \"0x{}\", \"address\": \"{}\" }}", hex(&salt), checksum(&a));
        }
        _ => {
            eprintln!("usage: vanity-create2 mine|address --factory 0x.. --init-hash 0x.. [--chain-id N] [--zeros N --tag NAME] [--salt 0x..]");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx {
            factory: parse_hex("0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"),
            init_hash: parse_hex("0xabababababababababababababababababababababababababababababababab"),
            chain_id: 1,
        }
    }

    // From CreateX itself: computeCreate2Address(keccak256(abi.encode(1, salt)), initCodeHash, CreateX) on a mainnet fork.
    #[test]
    fn matches_createx() {
        let salt: [u8; 32] = parse_hex("0x0000000000000000000000000000000000000000010000000000000000000042");
        assert_eq!(checksum(&address_of(&ctx(), &salt)), "0x72e71aCd5DE3977138994030d2672a961a176AE6");
    }

    #[test]
    fn another_chain_gives_another_address() {
        let salt: [u8; 32] = parse_hex("0x0000000000000000000000000000000000000000010000000000000000000042");
        let mut c = ctx();
        c.chain_id = 8453;
        assert_ne!(address_of(&c, &salt), address_of(&ctx(), &salt));
    }

    #[test]
    fn checksum_is_eip55() {
        let a: [u8; 20] = parse_hex("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
        assert_eq!(checksum(&a), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    }
}
