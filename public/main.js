/* main.js - cleaned & robust; bottom sheet on mobile; swipe-to-close */
document.addEventListener('DOMContentLoaded', () => {
  const socket = (typeof io === 'function') ? io() : null;
  const socket = io("https://visionmeet-f3e1.onrender.com");
  const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const urlParts = location.pathname.split('/').filter(Boolean);
  const roomId = urlParts.includes('room') ? urlParts[urlParts.indexOf('room') + 1] : null;

  const localVideoContainer = document.getElementById('videos');
  const chatWindow = document.getElementById('chatWindow');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const roomIdEl = document.getElementById('roomId');

  const muteBtn = document.getElementById('muteBtn');
  const videoBtn = document.getElementById('videoBtn');
  const shareBtn = document.getElementById('shareBtn');
  const copyBtn = document.getElementById('copyBtn');
  const leaveBtn = document.getElementById('leaveBtn'); // 👈 added leave button hook

  const chatToggle = document.getElementById('chatToggle');
  const sidePanel = document.getElementById('side');
  const closeChat = document.getElementById('closeChat');
  const backdrop = document.getElementById('backdrop');

  if (roomIdEl) roomIdEl.textContent = roomId || 'none';
  if (!roomId) {
    document.body.innerHTML = '<p style="padding:20px">No room ID. Go to <a href="/room">/room</a> to create a room.</p>';
    console.error('No room id in URL');
    return;
  }

  let localStream = null;
  let audioEnabled = true;
  let videoEnabled = true;
  const peers = {};
  const remoteVideos = {};

  async function initLocalStream() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      console.warn('getUserMedia audio+video failed, trying video-only', e);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err) {
        console.error('getUserMedia failed entirely', err);
        localStream = null;
      }
    }
    addLocalVideo();
    attachLocalTracksToAllPeers();
    return localStream;
  }

  function addLocalVideo() {
    if (!localVideoContainer) return;
    const existing = document.getElementById('localVideo');
    if (existing) { existing.srcObject = localStream; return; }
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = localStream; v.id = 'localVideo';
    const wrapper = document.createElement('div'); wrapper.className = 'video-wrap'; wrapper.appendChild(v);
    const label = document.createElement('div'); label.className = 'local-label'; label.textContent = 'You';
    wrapper.appendChild(label);
    localVideoContainer.prepend(wrapper);
  }

  function attachLocalTracksToAllPeers() {
    if (!localStream) return;
    Object.values(peers).forEach(pc => {
      try {
        const senders = pc.getSenders();
        localStream.getTracks().forEach(track => {
          const has = senders.some(s => s.track && s.track.kind === track.kind);
          if (!has) pc.addTrack(track, localStream);
        });
      } catch (e) { console.warn('attachLocalTracksToAllPeers error', e); }
    });
  }

  function createPeer(socketId, isOfferer = false) {
    if (!socketId) return null;
    if (peers[socketId]) return peers[socketId];
    const pc = new RTCPeerConnection(pcConfig);
    peers[socketId] = pc;

    if (localStream) {
      try { localStream.getTracks().forEach(track => pc.addTrack(track, localStream)); } catch(e){/*ignore*/ }
    }

    pc.ontrack = (ev) => {
      const stream = (ev.streams && ev.streams[0]) || null;
      if (!stream) return;
      let remoteVideo = document.getElementById('video_' + socketId);
      if (!remoteVideo) {
        const wrapper = document.createElement('div'); wrapper.className='video-wrap';
        remoteVideo = document.createElement('video'); remoteVideo.autoplay = true; remoteVideo.playsInline = true;
        remoteVideo.id = 'video_' + socketId;
        wrapper.appendChild(remoteVideo);
        const lbl = document.createElement('div'); lbl.className = 'local-label'; lbl.textContent = socketId;
        wrapper.appendChild(lbl);
        localVideoContainer.appendChild(wrapper);
        remoteVideos[socketId] = remoteVideo;
      }
      if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('signal', { to: socketId, from: socket.id, type: 'ice-candidate', data: event.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (['disconnected','failed','closed'].includes(state)) cleanupPeer(socketId);
    };

    if (isOfferer) (async () => {
      await initLocalStream();
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (socket) socket.emit('signal', { to: socketId, from: socket.id, type: 'offer', data: pc.localDescription });
      } catch (e) { console.error('offer error', e); }
    })();

    return pc;
  }

  function cleanupPeer(socketId) {
    const pc = peers[socketId];
    if (pc) try{ pc.close(); }catch(e){}
    delete peers[socketId];
    const vid = remoteVideos[socketId] || document.getElementById('video_' + socketId);
    if (vid && vid.parentNode) vid.parentNode.remove();
    delete remoteVideos[socketId];
  }

  /* Socket handlers */
  if (socket) {
    socket.on('connect', async () => {
      await initLocalStream();
      const name = prompt('Enter your name') || 'Guest';
      socket.emit('join-room', roomId, name);
    });
    socket.on('existing-users', async (list) => {
      await initLocalStream();
      list.forEach(id => createPeer(id, true));
    });
    socket.on('user-joined', ({ socketId, name }) => {
      createPeer(socketId, false);
      appendSystemMessage(`${name || socketId} joined`);
    });
    socket.on('signal', async ({ from, type, data }) => {
      if (!from) return;
      let pc = peers[from] || createPeer(from, false);
      try {
        if (type === 'offer') {
          await initLocalStream();
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, from: socket.id, type: 'answer', data: pc.localDescription });
        } else if (type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        } else if (type === 'ice-candidate') {
          try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch(e){/*ignore*/ }
        }
      } catch (e) { console.error('signal handling error', e); }
    });
    socket.on('user-left', ({ socketId, name }) => {
      cleanupPeer(socketId);
      appendSystemMessage(`${name || socketId} left`);
    });
  }

  /* Chat logic */
  chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = chatInput?.value?.trim();
    if (!v) return;
    if (socket) socket.emit('message', { room: roomId, msg: v });
    appendChatMessage('Me', v);
    if (chatInput) chatInput.value = '';
  });

  if (socket) {
    socket.on('message', ({ from, name, msg }) => appendChatMessage(name || from, msg));
  }

  function appendChatMessage(name, msg) {
    if (!chatWindow) return;
    const d = document.createElement('div'); d.className = 'message';
    d.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(msg)}`;
    chatWindow.appendChild(d); chatWindow.scrollTop = chatWindow.scrollHeight;
  }
  function appendSystemMessage(txt) {
    if (!chatWindow) return;
    const d = document.createElement('div'); d.className = 'message'; d.style.opacity = 0.75; d.textContent = txt;
    chatWindow.appendChild(d); chatWindow.scrollTop = chatWindow.scrollHeight;
  }
  function escapeHtml(s) { if (!s) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }

  /* Controls */
  muteBtn?.addEventListener('click', () => {
    if (!localStream) return;
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
    muteBtn.style.opacity = audioEnabled ? '1' : '0.55';
  });

  videoBtn?.addEventListener('click', () => {
    if (!localStream) return;
    videoEnabled = !videoEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
    videoBtn.style.opacity = videoEnabled ? '1' : '0.55';
  });

  shareBtn?.addEventListener('click', async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      Object.values(peers).forEach(pc => {
        try { const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video'); if (sender) sender.replaceTrack(screenTrack); } catch(e){}
      });
      const localVid = document.getElementById('localVideo'); if (localVid) localVid.srcObject = screenStream;
      screenTrack.addEventListener('ended', () => {
        if (!localStream) return;
        const cameraTrack = localStream.getVideoTracks()[0];
        Object.values(peers).forEach(pc => {
          try { const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video'); if (sender && cameraTrack) sender.replaceTrack(cameraTrack); } catch(e){}
        });
        if (localVid) localVid.srcObject = localStream;
      });
    } catch (e) { console.warn('share failed', e); }
  });

  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      const prev = copyBtn.textContent;
      copyBtn.textContent = '✅';
      setTimeout(() => copyBtn.textContent = prev, 30000);
    } catch {
      try { const ta = document.createElement('textarea'); ta.value = location.href; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch(e){}
    }
  });

  /* Leave / End Meeting */
  leaveBtn?.addEventListener('click', () => {
    // Close all peers
    Object.values(peers).forEach(pc => {
      try { pc.close(); } catch(e) {}
    });

    // Stop local media
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }

    // Disconnect socket
    if (socket) {
      socket.disconnect();
    }

    // Clear UI
    if (localVideoContainer) {
      localVideoContainer.innerHTML = '<p style="text-align:center;margin-top:20px;">You have left the meeting.</p>';
    }

    // Redirect after short delay
    setTimeout(() => {
      window.location.href = "/"; // change if you have a custom goodbye page
    }, 1500);
  });

  /* Chat drawer: open/close functions */
  function openChat() {
    if (!sidePanel) return;
    sidePanel.classList.add('open');
    sidePanel.setAttribute('aria-hidden', 'false');
    if (backdrop) { backdrop.classList.add('show'); backdrop.setAttribute('aria-hidden','false'); }
    sidePanel.style.transform = '';
  }

  function closeChatFn() {
    if (!sidePanel) return;
    sidePanel.classList.remove('open');
    sidePanel.setAttribute('aria-hidden','true');
    if (backdrop) { backdrop.classList.remove('show'); backdrop.setAttribute('aria-hidden','true'); }
    sidePanel.style.transform = '';
  }

  chatToggle?.addEventListener('click', openChat);
  closeChat?.addEventListener('click', closeChatFn);
  backdrop?.addEventListener('click', closeChatFn);

  // ESC closes drawer
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChatFn(); });

  /* Swipe-to-close on mobile */
  if (sidePanel) {
    let startY = 0, currentY = 0, touching = false;

    sidePanel.addEventListener('touchstart', (ev) => {
      if (!sidePanel.classList.contains('open')) return;
      if (window.innerWidth > 768) return; 
      startY = ev.touches[0].clientY;
      touching = true;
      sidePanel.style.transition = 'none';
    }, { passive: true });

    sidePanel.addEventListener('touchmove', (ev) => {
      if (!touching) return;
      currentY = ev.touches[0].clientY;
      const delta = Math.max(0, currentY - startY);
      sidePanel.style.transform = `translateY(${delta}px)`;
      if (backdrop) {
        const pct = Math.min(1, delta / (window.innerHeight * 0.6));
        backdrop.style.opacity = `${1 - pct * 0.7}`;
      }
    }, { passive: true });

    sidePanel.addEventListener('touchend', () => {
      if (!touching) return;
      touching = false;
      sidePanel.style.transition = '';
      const delta = Math.max(0, currentY - startY);
      const threshold = Math.max(80, window.innerHeight * 0.12);
      if (delta > threshold) {
        closeChatFn();
      } else {
        sidePanel.style.transform = '';
        if (backdrop) backdrop.style.opacity = '';
      }
      startY = currentY = 0;
    }, { passive: true });
  }

  // init preview early
  initLocalStream();

}); // DOMContentLoaded end

