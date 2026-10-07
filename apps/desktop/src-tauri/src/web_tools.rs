use reqwest::{blocking::Client, Url};
use serde::Serialize;
use std::{
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};
#[derive(Serialize)]
pub struct Page {
    url: String,
    content: String,
    truncated: bool,
}
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let [x, y, z, _] = a.octets();
            !(a.is_private()
                || a.is_loopback()
                || a.is_link_local()
                || a.is_broadcast()
                || a.is_unspecified()
                || a.is_multicast()
                || x == 0
                || x >= 240
                || x == 100 && (64..=127).contains(&y)
                || x == 192 && y == 0
                || x == 198 && (y == 18 || y == 19)
                || x == 198 && y == 51 && z == 100
                || x == 203 && y == 0 && z == 113)
        }
        IpAddr::V6(a) => {
            if let Some(v) = a.to_ipv4_mapped() {
                return public(IpAddr::V4(v));
            }
            let first = a.segments()[0];
            first & 0xe000 == 0x2000
                && !(a.segments()[0] == 0x2001 && a.segments()[1] == 0xdb8)
                && !(a.is_loopback()
                    || a.is_unspecified()
                    || a.is_multicast()
                    || first & 0xfe00 == 0xfc00
                    || first & 0xffc0 == 0xfe80)
        }
    }
}
fn client(url: &Url) -> Result<Client, String> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Only public HTTPS URLs without credentials are allowed".into());
    }
    let host = url.host_str().ok_or("Missing hostname")?;
    let addresses: Vec<_> = (host, url.port_or_known_default().unwrap_or(443))
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public(a.ip())) {
        return Err("Private/reserved network addresses are blocked".into());
    }
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .resolve_to_addrs(host, &addresses)
        .user_agent("Gustaf/0.1 web-fetch")
        .build()
        .map_err(|e| e.to_string())
}
fn clean(html: &str) -> String {
    let headings = regex::Regex::new(r"(?is)<h([1-6])\b[^>]*>(.*?)</h[1-6]\s*>")
        .unwrap()
        .replace_all(html, |c: &regex::Captures| {
            format!(
                "\n{} {}\n",
                "#".repeat(c[1].parse::<usize>().unwrap_or(1)),
                &c[2]
            )
        });
    let html = &*headings;
    let s = regex::Regex::new(
        r"(?is)<(script|style|noscript)\b[^>]*>.*?</(?:script|style|noscript)\s*>",
    )
    .unwrap()
    .replace_all(html, "");
    let s = regex::Regex::new(r"(?i)</?(?:p|div|br|h[1-6]|li|section|article|pre|tr)\b[^>]*>")
        .unwrap()
        .replace_all(&s, "\n");
    let s = regex::Regex::new(r"(?s)<[^>]*>")
        .unwrap()
        .replace_all(&s, "");
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn domain_allowed(url: &Url, allow: &[String], deny: &[String]) -> bool {
    let host = url.host_str().unwrap_or("").to_lowercase();
    let matches = |d: &String| {
        let d = d.trim().to_lowercase();
        !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
    };
    !deny.iter().any(matches) && (allow.is_empty() || allow.iter().any(matches))
}
fn fetch(mut url: Url, allow: Vec<String>, deny: Vec<String>) -> Result<Page, String> {
    for _ in 0..5 {
        if !domain_allowed(&url, &allow, &deny) {
            return Err("Redirect/URL domain is blocked by web settings".into());
        }
        let mut response = client(&url)?
            .get(url.clone())
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            let target = response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                .ok_or("Redirect missing Location")?;
            url = url.join(target).map_err(|e| e.to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !content_type.contains("text/") && !content_type.contains("json") {
            return Err("Unsupported content type; use a text/HTML page".into());
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let truncated = bytes.len() > 1_048_576;
        bytes.truncate(1_048_576);
        let raw = String::from_utf8_lossy(&bytes);
        let text = if content_type.contains("html") {
            clean(&raw)
        } else {
            raw.into_owned()
        };
        let clipped = text.chars().take(30000).collect::<String>();
        return Ok(Page {
            url: url.to_string(),
            truncated: truncated || clipped.len() < text.len(),
            content: clipped,
        });
    }
    Err("Too many redirects".into())
}
#[tauri::command]
pub async fn web_fetch(
    url: String,
    allow: Option<Vec<String>>,
    deny: Option<Vec<String>>,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch(
            Url::parse(&url).map_err(|e| e.to_string())?,
            allow.unwrap_or_default(),
            deny.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn web_search(query: String) -> Result<serde_json::Value, String> {
    if query.trim().is_empty() || query.len() > 1000 {
        return Err("Query must contain 1–1000 characters".into());
    }
    tauri::async_runtime::spawn_blocking(move||{
 let key=crate::secrets::read("web:brave").ok_or("Configure a Brave Search API key in Settings")?;
 let mut url=Url::parse("https://api.search.brave.com/res/v1/web/search").unwrap();url.query_pairs_mut().append_pair("q",&query).append_pair("count","8");
 let response=client(&url)?.get(url).header("X-Subscription-Token",key).send().map_err(|e|e.to_string())?;
 if !response.status().is_success(){return Err(format!("Search HTTP {}",response.status()));}
 let mut bytes=Vec::new();response.take(1_048_577).read_to_end(&mut bytes).map_err(|e|e.to_string())?;if bytes.len()>1_048_576{return Err("Search response too large".into());}
 let data:serde_json::Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
 let rows=data["web"]["results"].as_array().cloned().unwrap_or_default().into_iter().take(8).map(|v|serde_json::json!({"title":v["title"].as_str().unwrap_or("").chars().take(1000).collect::<String>(),"url":v["url"].as_str().unwrap_or("").chars().take(2000).collect::<String>(),"description":clean(v["description"].as_str().unwrap_or("")).chars().take(3000).collect::<String>()})).collect::<Vec<_>>();
 Ok(serde_json::json!({"results":rows}))
 }).await.map_err(|e|e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_addresses_are_denied() {
        for s in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
        ] {
            assert!(!public(s.parse().unwrap()));
        }
        assert!(public("8.8.8.8".parse().unwrap()));
    }
    #[test]
    fn redirect_domain_policy_is_enforced() {
        let u = Url::parse("https://sub.example.com/x").unwrap();
        assert!(domain_allowed(&u, &["example.com".into()], &[]));
        assert!(!domain_allowed(&u, &["another.com".into()], &[]));
        assert!(!domain_allowed(&u, &[], &["example.com".into()]));
    }
    #[test]
    fn html_scripts_are_not_returned() {
        assert_eq!(
            clean("<h1>Title</h1><script>secret</script><p>Hello &amp; world</p>"),
            "# Title\nHello & world"
        );
    }
}
