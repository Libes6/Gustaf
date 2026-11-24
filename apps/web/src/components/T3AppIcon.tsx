// The icon of the T3 Code for GitHub app, as GitHub shows it. Gustaf's own icon would be wrong here.
import appIconUrl from "../assets/t3-code-for-github.png";

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
