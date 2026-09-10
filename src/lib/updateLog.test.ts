import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMITS_PER_PAGE, commitsUrl, fetchUpdateLog, pageNumbers, parseUpdateLogPage } from "./updateLog";

describe("update log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds a paginated main-branch commits URL", () => {
    expect(commitsUrl("E4B-labs/multibot-desktop", 3)).toBe(
      `https://api.github.com/repos/E4B-labs/multibot-desktop/commits?sha=main&per_page=${COMMITS_PER_PAGE}&page=3`,
    );
  });

  it("parses commit summaries and detects an older page", () => {
    const result = parseUpdateLogPage(
      [
        {
          sha: "123456789abcdef",
          html_url: "https://github.com/E4B-labs/multibot-desktop/commit/1234567",
          commit: { message: "Add update log\n\nDetails", author: { date: "2026-09-02T10:00:00Z" } },
        },
        { sha: "missing-fields" },
      ],
      2,
      '<https://api.github.com/repos/E4B-labs/multibot-desktop/commits?page=3>; rel="next", <https://api.github.com/repos/E4B-labs/multibot-desktop/commits?page=12>; rel="last"',
    );

    expect(result).toEqual({
      page: 2,
      hasNext: true,
      totalPages: 12,
      entries: [{
        sha: "123456789abcdef",
        shortSha: "1234567",
        message: "Add update log",
        date: "2026-09-02T10:00:00Z",
        url: "https://github.com/E4B-labs/multibot-desktop/commit/1234567",
      }],
    });
  });

  it("keeps page 1 newest and numbers older pages in order", () => {
    expect(pageNumbers(1, 12)).toEqual([1, 2, 3, 4, 5, "…", 12]);
    expect(pageNumbers(6, 12)).toEqual([1, "…", 5, 6, 7, "…", 12]);
  });

  it("fetches a page and reports GitHub failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { link: "" } }));
    await expect(fetchUpdateLog("E4B-labs/multibot-desktop", 1)).resolves.toEqual({ page: 1, hasNext: false, totalPages: 1, entries: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/E4B-labs/multibot-desktop/commits?"),
      expect.objectContaining({ headers: { Accept: "application/vnd.github+json" } }),
    );

    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    await expect(fetchUpdateLog("E4B-labs/multibot-desktop", 2)).rejects.toThrow("Update log unavailable (403).");
  });
});
