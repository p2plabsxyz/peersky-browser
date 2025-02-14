class PeerBar extends HTMLElement {
  constructor() {
    super();
    this.build();
  }

  build() {
    const container = document.createElement('div');
    container.className = 'peerbar';

    const links = [
      { href: 'peersky://p2p/chat/', img: 'chat.svg', alt: 'Peersky Chat' },
      { href: 'peersky://p2p/upload/', img: 'upload.svg', alt: 'Peersky Upload' },
      { href: 'peersky://p2p/editor/', img: 'build.svg', alt: 'Peersky Build' },
      { href: 'https://reader.distributed.press/', img: 'people.svg', alt: 'Social Reader' }
    ];

    links.forEach(link => {
      const a = document.createElement('a');
      a.href = link.href;
      const img = document.createElement('img');
      img.src = `peersky://static/assets/svg/${link.img}`;
      img.alt = link.alt;
      a.appendChild(img);
      container.appendChild(a);
    });

    this.appendChild(container);
  }
}

window.customElements.define('peer-bar', PeerBar);
