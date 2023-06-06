module.exports = {
    directoryListingHtml: (shortCID, filesHtml) => `
        <html>
          <style>html, body { margin: auto; height: 100%; width: 100%; }</style>
          <body>
            <div style="background-color: #22d3ee; margin: auto; width: 100%; padding: 10px;">
              <img src="https://bafkreicuwr2ymmmi3c55oz5l65z4662xjndjecyzlfwag3lma3el5yt7lq.ipfs.w3s.link/" width="50" alt="Peersky Browser Logo" />
            </div>
            <h2 style="margin-left: 14px;">Index of /ipfs/${shortCID}</h2>
            <ul>
              ${filesHtml}
            </ul>
          </body>
        </html>
      `,
  };
  