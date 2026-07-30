import { expect, test } from "@playwright/test";

const samples = {
  singleA: "https://detail.1688.com/offer/1013001591920.html?spm=a26352.13672862.offerlist.74.64241e62GBUfEO&cosite=-&tracelog=p4p&_p_isad=1&clickid=d609322de4c446eb9c7ad5f32c7264ef&sessionid=79d7417242becda81904b0b6debcf258",
  singleB: "https://detail.1688.com/offer/892408514788.html",
  batch: "https://s.1688.com/selloffer/offer_search.htm?keywords=%BC%D2%BE%DF%D7%B0%CA%CE%B0%DA%BC%FE&spm=a26352.13672862.searchbox.0"
};

test("documents fixed Gate 5 samples for local live acceptance", async () => {
  expect(samples.singleA).toContain("1013001591920");
  expect(samples.singleB).toContain("892408514788");
  expect(samples.batch).toContain("s.1688.com");
});
