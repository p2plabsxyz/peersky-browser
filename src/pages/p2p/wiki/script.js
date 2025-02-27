const searchInput = document.getElementById("searchInput");
const suggestionsList = document.getElementById("suggestionsList");
const searchForm = document.getElementById("searchForm");
const errorMessage = document.getElementById("errorMessage");
let debounceTimeout;

function isP2PEnvironment() {
  const protocol = window.location.protocol;
  const isIpfs = protocol.startsWith("ipfs") || protocol.startsWith("ipns");
  const ua = navigator.userAgent.toLowerCase();
  const isPeersky = ua.includes("peersky");
  const isAgregore = ua.includes("agregore");
  return isIpfs || isPeersky || isAgregore;
}

function getIpfsBaseUrl() {
  // If in a true P2P environment (or recognized one like Peersky or Agregore), use IPNS://
  if (isP2PEnvironment()) {
    return "ipns://en.wikipedia-on-ipfs.org/";
  } else {
    // Otherwise, fallback to the HTTP gateway
    return "https://en-wikipedia--on--ipfs-org.ipns.dweb.link/";
  }
}

// Helper: fallback formatting in case we don’t get a resolved title.
// It capitalizes each word and replaces spaces with underscores.
function formatQuery(query) {
  return query
    .trim()
    .split(" ")
    .filter((word) => word.length)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("_");
}

// Redirect to the final article link (IPNS or gateway).
function navigateToArticle(query) {
  const formattedQuery = formatQuery(query);
  const finalUrl = getIpfsBaseUrl() + "wiki/" + formattedQuery;
  window.location.href = finalUrl;
}

/**
 * Use the Official Wikipedia API (over HTTPS) to find the canonical title for `query`.
 * Then we redirect to our IPFS version of that canonical title.
 * This step ensures that e.g. searching “computer science”
 * will get a properly capitalized official title.
 */
function resolveQuery(query) {
  const apiUrl =
    "https://en.wikipedia.org/w/api.php?origin=*&action=query&format=json&titles=" +
    encodeURIComponent(query);

  return fetch(apiUrl)
    .then((response) => response.json())
    .then((data) => {
      // If there's any normalization (e.g. “computer science” → “Computer science”), use it.
      let resolvedTitle = query;
      if (data.query.normalized && data.query.normalized.length > 0) {
        resolvedTitle = data.query.normalized[0].to;
      }

      // Check if the page exists
      const pages = data.query.pages;
      const pageKey = Object.keys(pages)[0];
      if (pages[pageKey].missing !== undefined) {
        // The page does not exist
        return null;
      }
      return resolvedTitle;
    });
}

/**
 * Returns suggestions from Wikipedia on IPFS
 */
function fetchSuggestions(query) {
  const apiUrl =
    "https://en.wikipedia.org/w/api.php?origin=*&action=opensearch&format=json&search=" +
    encodeURIComponent(query);

  fetch(apiUrl)
    .then((response) => response.json())
    .then((data) => {
      // data format: [searchTerm, [suggestions], [descriptions], [links]]
      const suggestions = data[1];
      renderSuggestions(suggestions);
    })
    .catch((error) => {
      console.error("Error fetching suggestions:", error);
      suggestionsList.innerHTML = "";
    });
}

// Display the list of suggestions as clickable items.
function renderSuggestions(suggestions) {
  suggestionsList.innerHTML = "";
  if (!suggestions || suggestions.length === 0) {
    return;
  }
  suggestions.forEach((suggestion) => {
    const li = document.createElement("li");
    li.textContent = suggestion;

    li.addEventListener("click", () => {
      // When a suggestion is clicked, we first do a canonical resolution:
      resolveQuery(suggestion).then((resolvedTitle) => {
        if (resolvedTitle) {
          const finalTitle = resolvedTitle.replace(/ /g, "_");
          const finalUrl = getIpfsBaseUrl() + "wiki/" + finalTitle;
          window.location.href = finalUrl;
        } else {
          // If no canonical resolution, just attempt the fallback format
          navigateToArticle(suggestion);
        }
      });
    });

    suggestionsList.appendChild(li);
  });
}

// Listen for input events and fetch suggestions (debounced).
searchInput.addEventListener("input", () => {
  const query = searchInput.value;
  clearTimeout(debounceTimeout);

  if (query.trim().length < 3) {
    suggestionsList.innerHTML = "";
    return;
  }

  debounceTimeout = setTimeout(() => {
    fetchSuggestions(query);
  }, 300);
});

// Handle the form submission: canonicalize via the official Wikipedia API, then go to IPFS link.
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  errorMessage.textContent = "";

  const query = searchInput.value.trim();
  if (!query) return;

  const button = searchForm.querySelector("button");
  button.textContent = "Loading...";

  resolveQuery(query)
    .then((resolvedTitle) => {
      if (resolvedTitle) {
        const finalTitle = resolvedTitle.replace(/ /g, "_");
        const finalUrl = getIpfsBaseUrl() + "wiki/" + finalTitle;
        window.location.href = finalUrl;
      } else {
        // Show an error if page not found and revert button text.
        errorMessage.textContent = `No Wikipedia article found for "${query}". Please check your spelling or try another term.`;
        button.textContent = "Search";
      }
    })
    .catch((err) => {
      console.error("Error resolving query:", err);
      errorMessage.textContent = `An error occurred while searching for "${query}". Please try again later.`;
      button.textContent = "Search";
    });
});
