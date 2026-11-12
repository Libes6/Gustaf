export function UserAvatar({
  name,
  image,
  size = "sm",
}: {
  readonly name: string;
  readonly image: string | null;
  readonly size?: "sm" | "lg";
}) {
  const className = size === "lg" ? "size-12 text-base" : "size-7 text-xs";
  if (image) {
    return (
      <img
        src={image}
        alt=""
        referrerPolicy="no-referrer"
        className={`${className} shrink-0 rounded-full bg-accent object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-full bg-accent font-medium text-muted-foreground`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
