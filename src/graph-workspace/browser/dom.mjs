// Tiny DOM helpers. Text is always assigned as text; no HTML strings.
export const $ = id => document.getElementById(id)
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'style') node.setAttribute('style', value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'open' || key === 'selected') node[key] = !!value
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  if (tag === 'textarea' && children.length) node.value = children.flat().filter(c => typeof c === 'string').join('')
  return node
}
export const clear = node => { while (node.firstChild) node.firstChild.remove() }
