const messages = [
  ['maya', 'wait, Nova?? Brim had the better story'],
  ['kai', 'we just missed the Brim secret ending 😭'],
  ['nora', 'Nova fits this team better though'],
  ['zoe', 'Brim deserved that quest. who else agrees?']
];
const feed = document.querySelector('#demo-chat');
const invitation = document.querySelector('#demo-invitation');
const room = document.querySelector('#demo-room');
const status = document.querySelector('#demo-status');
let timers = [];
function replay() {
  timers.forEach(clearTimeout); timers = [];
  feed.replaceChildren(); invitation.hidden = true; room.hidden = true;
  document.querySelector('#demo-you').hidden = true;
  document.querySelector('#demo-send').hidden = false;
  status.textContent = '01 / THE MOMENT';
  messages.forEach(([user, text], index) => {
    timers.push(setTimeout(() => {
      const line = document.createElement('p');
      const name = document.createElement('b'); name.textContent = user;
      line.append(name, document.createTextNode(text)); feed.append(line);
      if(index === 2) status.textContent = '02 / SHARED REACTION FOUND';
    }, 500 + index * 900));
  });
  timers.push(setTimeout(() => { invitation.hidden = false; status.textContent = '03 / YOUR INVITATION'; }, 4600));
}
document.querySelector('#demo-replay').addEventListener('click', replay);
document.querySelector('#demo-join').addEventListener('click', () => { invitation.hidden = true; room.hidden = false; status.textContent = '04 / YOU FOUND YOUR PEOPLE'; });
document.querySelector('#demo-leave').addEventListener('click', () => { room.hidden = true; invitation.hidden = false; status.textContent = '03 / JOINING IS YOUR CHOICE'; });
document.querySelector('#demo-send').addEventListener('click', (event) => { document.querySelector('#demo-you').hidden = false; event.currentTarget.hidden = true; });
const moments = {
  plot: ['!?', 'We need to talk about that ending.', 'The credits roll. Your jaw is still on the floor. Find the other viewers connecting the same dots.', 'THE ENDING DEBRIEF ↗'],
  clutch: ['GG', 'That was absolutely ridiculous.', 'One impossible play. Everyone loses it. Relive the moment with the viewers still trying to process what just happened.', 'THE CLUTCH AFTERPARTY ↗'],
  choice: ['WHY', 'We would have picked Brim.', 'The streamer made their choice. You have opinions. Find the viewers who saw the same missed opportunity.', 'JUSTICE FOR BRIM ↗']
};
const tabs = [...document.querySelectorAll('[data-moment]')];
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    tabs.forEach(other => { const active = other === tab; other.setAttribute('aria-selected', String(active)); other.tabIndex = active ? 0 : -1; });
    const [art, title, description, stamp] = moments[tab.dataset.moment];
    document.querySelector('#moment-art').textContent = art;
    document.querySelector('#moment-title').textContent = title;
    document.querySelector('#moment-description').textContent = description;
    document.querySelector('#moment-stamp').textContent = stamp;
    document.querySelector('#moment-panel .eyebrow').textContent = 'EXAMPLE ROOM / 0' + (index + 1);
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    event.preventDefault(); const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; next.click(); next.focus();
  });
});
const observer = new IntersectionObserver(entries => { if(entries.some(entry => entry.isIntersecting)){ replay(); observer.disconnect(); } }, { threshold: .3 });
observer.observe(document.querySelector('#demo'));
