// This network account's prover credit, for the relay's replenish loop: prints BALANCE=<PROVE in wei>.
// Reads NETWORK_PRIVATE_KEY and NETWORK_RPC_URL from the environment, as every exec-* binary does.
use sp1_sdk::blocking::ProverClient;

fn main() {
    let client = ProverClient::builder().network().build();
    let balance = client.get_balance().expect("balance read failed");
    println!("BALANCE={balance}");
}
