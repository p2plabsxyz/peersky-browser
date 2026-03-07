# Web3 Protocol (`web3://`)

Peersky supports browsing and fetching on-chain resources through the `web3://` protocol.

This includes:

- Reading contract data directly from URL paths
- Loading contract-generated HTML/SVG resources
- Resolving names and addresses through Web3 URL tooling

## Basic usage

Open a `web3://` URL directly in the address bar.

Examples:

- Contract method call (JSON output):

```text
web3://0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/balanceOf/nemorino.eth?returns=(uint256)
```

- Contract-generated HTML page:

```text
web3://0x4e1f41613c9084fdb9e34e11fae9412427480e56/tokenHTML/9352
```

## Fetching from a page/app

You can fetch `web3://` URLs from app code in the browser context:

```js
async function fetchBalance() {
  const url = "web3://0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/balanceOf/nemorino.eth?returns=(uint256)";
  const response = await fetch(url);
  const text = await response.text();
  console.log("balanceOf response:", text); // e.g. ["0x0"]
}
```

```js
async function fetchTokenHtml() {
  const url = "web3://0x4e1f41613c9084fdb9e34e11fae9412427480e56/tokenHTML/9352";
  const response = await fetch(url);
  const html = await response.text();
  console.log("tokenHTML length:", html.length);
}
```

## Notes

- URL parsing behavior for `web3://` is different from regular `http(s)://` URLs.
- If you share examples in docs/issues, keep query params URL-encoded where needed.
- Some contracts return JSON, others return full HTML/SVG documents.

## References

- Web3 URL docs: https://docs.web3url.io/
- EIP-6860 (Web3 URL): https://eips.ethereum.org/EIPS/eip-6860

