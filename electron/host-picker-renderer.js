// Renderer script for host-picker.html. Talks only to window.hostPicker
// (exposed by host-picker-preload.cjs) — no Node here, contextIsolation
// stays on.

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function card(host, active, removable) {
  const el = document.createElement("div");
  el.className = "card";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<div class="name">${escapeHtml(host.name)}${active ? " · active" : ""}</div><div class="url">${escapeHtml(host.url)}</div>`;
  el.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  if (!active) {
    const use = document.createElement("button");
    use.className = "secondary";
    use.textContent = "Use";
    use.onclick = async () => {
      if (host.id === "local") await window.hostPicker.useLocal();
      else await window.hostPicker.useHost(host.id);
      window.close();
    };
    actions.appendChild(use);
  }
  if (removable) {
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Remove";
    del.onclick = async () => {
      await window.hostPicker.remove(host.id);
      await refresh();
    };
    actions.appendChild(del);
  }
  el.appendChild(actions);
  return el;
}

async function refresh() {
  const { activeId, hosts } = await window.hostPicker.list();
  const list = document.getElementById("list");
  list.innerHTML = "";
  list.appendChild(card({ id: "local", name: "This device", url: "Local harness" }, activeId === "local", false));
  for (const h of hosts) list.appendChild(card(h, activeId === h.id, true));
}

document.getElementById("add").addEventListener("click", async () => {
  const addButton = document.getElementById("add");
  const name = document.getElementById("name").value;
  const url = document.getElementById("url").value;
  const token = document.getElementById("token").value;
  const err = document.getElementById("err");
  err.textContent = "";
  addButton.disabled = true;
  try {
    await window.hostPicker.addRemote({ name, url, token });
    document.getElementById("name").value = "";
    document.getElementById("url").value = "";
    document.getElementById("token").value = "";
    await refresh();
  } catch (e) {
    err.textContent = e?.message || "Could not add host";
  } finally {
    addButton.disabled = false;
  }
});


void refresh();
