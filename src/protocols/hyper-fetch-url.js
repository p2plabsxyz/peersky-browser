// A hyper:// address as hypercore-fetch has to be given it.
//
// hypercore-fetch decodes the path with decodeURI, which leaves %26, %2C and
// the other escaped delimiters as they are. Pages escape a name with
// encodeURIComponent, as PeerTunes and the Hyperdrive app do, so a song named
// "Safe & Sound.mp3" was written as "Safe %26 Sound.mp3", and the phone, which
// asks for the real name, could not find it. Each part of the path is spelled
// so that decodeURI gives back the name the page meant. The query is kept as it
// came, since creating a drive is "hyper://localhost/?key=name".
export function toHyperFetchUrl (url) {
  const value = String(url)
  if (!/^hyper:\/\//i.test(value)) return value
  const start = value.indexOf('/', 'hyper://'.length)
  if (start === -1) return value
  const end = value.slice(start).search(/[?#]/)
  const rawPath = end === -1 ? value.slice(start) : value.slice(start, start + end)
  const rest = end === -1 ? '' : value.slice(start + end)
  const path = rawPath.split('/').map((part) => {
    let name
    try {
      name = decodeURIComponent(part)
    } catch {
      return part
    }
    // An escaped slash stays escaped, so it never becomes a new folder.
    return encodeURI(name).replace(/[?#/]/g, encodeURIComponent)
  }).join('/')
  return value.slice(0, start) + path + rest
}
