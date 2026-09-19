module.exports = function (eleventyConfig) {
  // Static assets pass through untouched
  eleventyConfig.addPassthroughCopy("css");
  eleventyConfig.addPassthroughCopy("js");
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy({ "uploads": "uploads" });

  // News articles, newest first
  eleventyConfig.addCollection("news", (collectionApi) => {
    return collectionApi.getFilteredByGlob("content/news/*.md").sort((a, b) => {
      return (b.data.date || "").localeCompare(a.data.date || "");
    });
  });

  // Upcoming shows, in the order given by the "order" field
  eleventyConfig.addCollection("shows", (collectionApi) => {
    return collectionApi.getFilteredByGlob("content/shows/*.md").sort((a, b) => {
      return (a.data.order || 0) - (b.data.order || 0);
    });
  });

  return {
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
