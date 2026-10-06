# PeerSky Privacy Policy

Last updated: October 6, 2026

PeerSky is a web and peer-to-peer browser for macOS, Windows and Linux. There
are no accounts, no analytics and no servers of ours, so there is nowhere for us
to collect anything even if we wanted to. Nobody at P2P Labs can see what you
browse, who you talk to, or that you use PeerSky at all.

This policy explains what PeerSky handles, where it goes, and the parts that are
not perfect.

## What We Do See

GitHub shows us how many times each release was downloaded, updates included.
It does not tell us who downloaded it.

## Data Stored on Your Computer

PeerSky stores settings, open tabs, history, bookmarks, extension data, PeerChat
chats and keys, and peer-to-peer data on your computer. None of it is sent to us.

PeerSky also keeps a log file on your computer to help find problems. It can
include addresses you opened over IPFS, Hyper, ENS and BitTorrent. It stays on
your computer unless you send it to someone yourself.

Settings, Search has two buttons for clearing data. Clear Cache removes
the browser cache, cookies and site storage. Reset P2P Data removes PeerChat
rooms, P2P app data, the ENS cache, torrent state, AI memory, and the IPFS and
Hyper data on your computer, and can also reset your peer-to-peer identities.
History is kept by the PeerSky History extension, and Delete All on its page
removes it.

## Updates

PeerSky checks for a new version 10 seconds after it starts and once a day
after that. On macOS it asks update.electronjs.org, a free service run by the
Electron project. On Windows and with the Linux AppImage it asks GitHub. Each
check sends PeerSky's version and your system and processor type, and, like
any request, your IP address. Updates download from GitHub. The Linux deb, rpm,
pacman and apk packages never check.

You can turn off Automatic updates in Settings, General, and still check by hand
with Check for Updates.

## Websites and Searches

Websites you visit can receive standard network information, including your IP
address, and may collect data under their own privacy policies. Searches typed
into the address bar go to the engine chosen in Settings, DuckDuckGo unless you
change it, and that engine's policy applies rather than this one. Suggestions in
the address bar come from your own history, on your computer.

## Peer-to-Peer Networks

Peer-to-peer is the part worth understanding. When PeerSky starts, it joins the
IPFS, Hyper and BitTorrent networks in the background, so addresses open
quickly. From then on, the public nodes that help computers find each other can
see your IP address, even before you open anything peer-to-peer, and so can the
peers you connect to. There is no onion routing to hide it. A VPN or proxy
extension covers websites only; peer-to-peer connections go around it. A VPN
for your whole computer covers them.

**Hyper.** Opening a `hyper://` address or using PeerChat connects your computer
directly to other computers, and those peers see your IP address the same way a
website does. Finding peers happens over a distributed hash table, starting from
public bootstrap nodes, and over your local network. The nodes that help see a
hashed topic, never a drive or room key and never the content.

**IPFS.** PeerSky finds IPFS peers through the public IPFS bootstrap nodes, a
distributed hash table, your local network, and delegated-ipfs.dev, a public
routing service. When it cannot find a peer that has what you asked for, it
asks the public gateways trustless-gateway.link and 4everland.io. These services
see the addresses you open. PeerSky tells other IPFS nodes that it is PeerSky
and which version, asks your router to open a port for it, and gets a
certificate for its address from libp2p.direct and Let's Encrypt so that other
browsers can reach it. What you upload to IPFS is announced to the network, and
other people can fetch it from your computer.

**BitTorrent.** When you open a torrent, PeerSky finds peers through the
trackers in it, a built-in list of public trackers, and BitTorrent's
distributed hash table. The trackers and the other people downloading it see
your IP address and what you are downloading. While it downloads, the pieces
you have are shared with others. When it finishes it stops, unless you choose
Start Seeding.

**ENS and web3.** PeerSky looks up `.eth` names through ethereum.publicnode.com,
a public Ethereum server. `web3://` addresses go to the same server, with
cloudflare-eth.com as a backup, or to public servers of another chain when the
address names one. These servers see the name or address you open and your IP
address.

## PeerChat

PeerChat rooms and direct messages are encrypted with a key only the people in
them hold, and attachments with a key derived from it. Two honest limits: a
room key is a shared secret, so anybody who has it can read that room including
its past messages, and it never rotates, meaning somebody removed from a room
still holds the key. What is encrypted is the content, not the fact that two
computers are talking.

Your PeerChat name, bio and photo are seen by everyone in the rooms you join. A
new PeerChat profile starts in P2P Republic, a public room anyone can join, so
people you do not know will see them there, along with your IP address while you
are both online. You can leave it from the chat list at any time.

When you send a link, your computer opens the page once to make a preview, so
that website sees your IP address as it would on a visit. The people you send
it to get the preview inside the message, and their computers do not open the
page. You can turn off Link previews in PeerChat's settings.

## Backups and Moving to Another Device

A backup holds your tabs, bookmarks, PeerChat rooms, Hyper drives, and the keys
that make them yours. It is always encrypted with a passphrase you choose, and
goes wherever you save it. Anyone who has both the file and the passphrase can
open it, so keep the passphrase to yourself. Nobody, including us, can recover
a forgotten one.

Moving your identity to another device goes over a temporary Hyper drive that
is deleted after 15 minutes at the most. It is encrypted so that only the
receiving device can open it.

## AI

AI is off until you turn it on in Settings. With a model on your computer, such
as Ollama, prompts and replies stay on your computer. If you point PeerSky at a
cloud service such as OpenRouter, they go to that service under its own policy.
An API key you enter is stored on your computer, encrypted with your system's
keychain when one is available. Once AI is on, PeerSky's own apps can use it.
Pages on `hyper://`, `ipfs://` and `ipns://`, local files, apps you added, and
pages on localhost and agregore.mauve.moe have to ask you first, and you can
change your answer in the site panel by the address bar. AI memory is off
unless you turn it on, and stays on your computer.

## Preinstalled Extensions

PeerSky comes with five extensions. They are run by other people, and some of
them talk to their own services:

- **Linguist**, the translator, sends its developer a note when it is installed
  or updated, when its popup opens, when its settings change, and when a
  translation fails, with a random ID it makes for itself, your browser's
  language and its user agent. When you translate a page, its text goes to
  Google, unless you pick the offline translator under Translation module in
  Linguist's settings. Text you have it read aloud goes to Google too.
- **Wayback Machine** asks archive.org whether it has a saved copy when a
  website answers with an error page, such as Page not found, which sends
  archive.org that page's address. You can turn this off in the extension's
  settings.
- **uBlock Origin** and **Consent Autodeny** download their filter lists and
  rules. Consent Autodeny sends a page's address to the Consent-O-Matic team at
  Aarhus University only if you report that page from it.
- **PeerSky History** keeps your history on your computer and sends nothing.

You can turn any of them off in Settings, Extensions. Extensions you add
yourself work under their own privacy policies.

## Reports

Reporting someone in PeerChat opens an email to us, which you can read before
you send it. It holds their name and peer ID, the room's name and a hash of its
key (never the key itself), and the time. We use it only to act on the report,
and we read every one within 24 hours. Nothing is sent unless you send that
email.

If you sent us a report, ask at contact@p2plabs.xyz and we delete it, unless
the law requires us to keep it.

## Deleting Your Data

There is no account on a server to delete. Reset P2P Data and Clear Cache in
Settings, Search remove what is described above, and uninstalling
PeerSky and deleting its data folder removes the rest. Messages you already
sent stay on the computers of the people you sent them to, and we have no way
to reach them.

## Children

PeerSky provides unrestricted browser access and is not directed to children,
and we collect nothing from anyone.

The peer-to-peer web has no moderator. In PeerChat groups, pictures are screened
on the computer before they are sent, text is filtered for abuse and slurs, and
adult domains are blocked in links. None of that replaces judgement about who you
share a room key with.

We do not tolerate child sexual abuse or exploitation in any form. Report it
from inside PeerChat or to contact@p2plabs.xyz, and we report what we learn to
the authorities, including the National Center for Missing and Exploited
Children. Our rules are in the [Terms of Use](TERMS.md).

## Changes

This policy may be updated as PeerSky changes. The latest version is published
in this repository.

## Contact

For privacy questions or content-removal requests, email contact@p2plabs.xyz.
Copyright notices go to the same address; what to include is in the
[Terms of Use](TERMS.md#copyright).
