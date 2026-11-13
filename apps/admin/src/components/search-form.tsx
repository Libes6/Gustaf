import { SearchIcon } from "lucide-react";
import { useId } from "react";

import { strings } from "../strings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Searches on submit (Enter or the button), so typing does not fire a request per key. */
export function SearchForm({
  label,
  placeholder,
  defaultValue,
  onSearch,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly defaultValue: string;
  readonly onSearch: (query: string) => void;
}) {
  const id = useId();
  return (
    <form
      role="search"
      className="flex min-w-0 flex-1 gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("query");
        onSearch(typeof value === "string" ? value.trim() : "");
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        name="query"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete="off"
      />
      <Button type="submit" variant="outline">
        <SearchIcon aria-hidden />
        <span className="max-sm:sr-only">{strings.common.search}</span>
      </Button>
    </form>
  );
}
