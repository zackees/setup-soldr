//! An adversarial Cargo build script for the isolated publisher boundary.
//! It prints the public marker and attempts the cache reservation protocol
//! against a deliberately anonymous, test-owned publisher endpoint.

use std::env;
use std::fs;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

fn main() {
    println!("cargo:warning=setup-soldr-ancestor-clean-save-v1 {{\"cache_id\":42,\"source_sha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}");
    for variable in [
        "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_CACHE_URL",
        "ACTIONS_RESULTS_URL", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH",
    ] {
        assert!(env::var_os(variable).is_none(), "host credential/control variable leaked: {variable}");
    }
    assert!(!Path::new("/var/run/docker.sock").exists(), "Docker socket leaked");
    assert!(!Path::new("/publisher/token").exists(), "publisher private files leaked");
    for path in ["/source/attack-write", "/tools/attack-write", "/registry/attack-write", "/llvm/attack-write"] {
        assert!(fs::write(path, b"untrusted").is_err(), "trusted input is writable: {path}");
    }
    let address: SocketAddr = env::var("BOUNDARY_UPLOAD_ADDRESS").unwrap().parse().unwrap();
    match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
        Ok(mut connection) => {
            connection.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
            let body = b"{\"key\":\"forged-untrusted-cache\",\"version\":\"test\"}";
            write!(connection, "POST /_apis/artifactcache/caches HTTP/1.1\r\nHost: publisher\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            connection.write_all(body).unwrap();
            panic!("source reached the host cache publisher and sent a manual reservation");
        }
        Err(error) => println!("cargo:warning=manual-upload-blocked: {error}"),
    }
    println!("cargo:warning=boundary-verified-no-upload");
}
