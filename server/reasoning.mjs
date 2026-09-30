// Compatibility for gateways that encode reasoning as a leading tagged block.
// Do not infer reasoning from natural language or strip tags quoted in an answer.
export function reasoningSplitter() {
  let buffer = '', mode = 'leading', tag = '';
  const openings = ['<think>', '<thinking>'];
  function drain(final = false) {
    const events = [];
    const emit = (type, text) => { if (text) events.push({ type, text }); };
    while (buffer) {
      if (mode === 'answer') { emit('delta', buffer); buffer = ''; break; }
      if (mode === 'leading') {
        const probe = buffer.trimStart().toLowerCase();
        const opening = openings.find(value => probe.startsWith(value));
        if (opening) {
          buffer = buffer.trimStart().slice(opening.length);
          tag = opening.slice(1, -1); mode = 'reasoning'; continue;
        }
        if (!final && buffer.length <= 256 && (!probe || openings.some(value => value.startsWith(probe)))) break;
        mode = 'answer'; continue;
      }
      const closing = `</${tag}>`, lower = buffer.toLowerCase(), end = lower.indexOf(closing);
      if (end >= 0) {
        emit('reasoning', buffer.slice(0, end));
        buffer = buffer.slice(end + closing.length); mode = 'leading'; continue;
      }
      let held = 0;
      if (!final) for (let size = 1; size < closing.length && size <= lower.length; size++) if (closing.startsWith(lower.slice(-size))) held = size;
      emit('reasoning', buffer.slice(0, buffer.length - held));
      buffer = held ? buffer.slice(-held) : ''; break;
    }
    return events;
  }
  return { push(text) { buffer += text; return drain(); }, finish() { return drain(true); } };
}
