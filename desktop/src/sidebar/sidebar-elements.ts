// These elements are required immediately after React commits the sidebar.
export function mountedElement<T extends Element>(value: T | null, name: string): T {
  if (!value) throw new Error(`Sidebar did not mount ${name}`);
  return value;
}
