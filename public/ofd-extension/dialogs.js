export function nativeDialog(dialog, primaryIds = []) {
  dialog.classList.add("ofdDialog");
  for (const group of dialog.querySelectorAll(".actions"))
    group.classList.add("buttonRow");
  for (const field of dialog.querySelectorAll(
    'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select',
  ))
    field.classList.add("toolbarField");
  dialog.addEventListener("toggle", (event) => {
    if (event.newState === "open") dialog.scrollTop = 0;
  });
  for (const button of dialog.querySelectorAll("button")) {
    button.classList.add(
      primaryIds.includes(button.id) ? "primaryButton" : "secondaryButton",
    );
  }
}
export function line(parent, content, tag = "p", className = "") {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  parent.append(element);
  return element;
}
