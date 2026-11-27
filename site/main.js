(() => {
  "use strict";

  // Interactive 4-Era Previewer in Hero
  const ERA_DATA = {
    "8bit": {
      src: "assets/gameplay-8bit.png",
      alt: "Pyria 8-Bit NES gameplay in Whispering Meadow showing the hero, Pip the dragon sidekick, minimap, and virtual thumbstick",
      title: "Era 1: 8-Bit NES — Whispering Meadow",
      desc: "Start with flat 8-bit pixels, chiptune music, and friendly Python spells like say(), variables, and loops.",
      caption: "Era 1 (8-Bit NES): Whispering Meadow — crisp 8-bit pixels, chiptune music, and your first Python spells.",
    },
    "16bit": {
      src: "assets/gameplay-16bit.png",
      alt: "Pyria 16-Bit SNES gameplay in Coral Shallows with upgraded 32x32 pixel art sprites",
      title: "Era 2: 16-Bit SNES — Coral Shallows",
      desc: "Restore all 8 Bits to unlock lush 32×32 SNES sprites, 4 themed Acts, lists, functions, and dictionaries.",
      caption: "Era 2 (16-Bit SNES): Coral Shallows — upgraded 32x32 SNES pixel art and multi-voice synth music.",
    },
    "32bit": {
      src: "assets/gameplay-32bit-iso.png",
      alt: "Pyria 32-Bit Isometric 2.5D gameplay in Blockstone Highlands with elevated terrain",
      title: "Era 3: 32-Bit Isometric 2.5D — Blockstone Highlands",
      desc: "The world tilts into an isometric PS1/GBA diorama with 3D stone terraces, tuples, comprehensions, and sets.",
      caption: "Era 3 (32-Bit Isometric 2.5D): Blockstone Highlands — tilted diorama perspective with elevated 3D terrain terraces.",
    },
    "64bit": {
      src: "assets/gameplay-64bit-n64.png",
      alt: "Pyria 64-Bit Nintendo 64 3D gameplay in Polygon Valley with third-person perspective camera",
      title: "Era 4: 64-Bit N64 3D — Polygon Valley",
      desc: "Burst into chunky Gouraud-shaded 3D with a follow camera while mastering 3D classes, inheritance, and assert tests.",
      caption: "Era 4 (64-Bit N64 3D): Polygon Valley — Gouraud-shaded 3D perspective with a third-person follow camera and distant mountains.",
    },
  };

  let currentEra = "8bit";
  const stageTabs = document.querySelectorAll(".stage-tab");
  const stageImage = document.getElementById("stage-image");
  const stageTitle = document.getElementById("stage-title");
  const stageDesc = document.getElementById("stage-desc");
  const stageZoomBtn = document.getElementById("stage-zoom-btn");

  function setEra(eraKey) {
    const info = ERA_DATA[eraKey];
    if (!info || !stageImage) return;
    currentEra = eraKey;
    stageImage.src = info.src;
    stageImage.alt = info.alt;
    if (stageTitle) stageTitle.textContent = info.title;
    if (stageDesc) stageDesc.textContent = info.desc;

    stageTabs.forEach((tab) => {
      const isActive = tab.dataset.era === eraKey;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
  }

  stageTabs.forEach((tab) => {
    tab.addEventListener("click", () => setEra(tab.dataset.era));
  });

  // Lightbox Modal
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxCaption = document.getElementById("lightbox-caption");

  function openLightbox(src, caption) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = caption || "Pyria screenshot";
    if (lightboxCaption) lightboxCaption.textContent = caption || "";
    lightbox.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true;
    document.body.style.overflow = "";
  }

  if (stageZoomBtn) {
    stageZoomBtn.addEventListener("click", () => {
      const info = ERA_DATA[currentEra];
      if (info) openLightbox(info.src, info.caption);
    });
  }

  document.querySelectorAll(".shot-trigger").forEach((btn) => {
    btn.addEventListener("click", () => {
      openLightbox(btn.dataset.lightboxSrc, btn.dataset.lightboxCaption);
    });
  });

  document.querySelectorAll("[data-lightbox-close]").forEach((el) => {
    el.addEventListener("click", closeLightbox);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightbox && !lightbox.hidden) {
      closeLightbox();
    }
  });

  // Mobile Menu Toggle
  const navToggle = document.getElementById("nav-toggle");
  const mobileMenu = document.getElementById("mobile-menu");

  if (navToggle && mobileMenu) {
    navToggle.addEventListener("click", () => {
      const expanded = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!expanded));
      mobileMenu.hidden = expanded;
    });

    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navToggle.setAttribute("aria-expanded", "false");
        mobileMenu.hidden = true;
      });
    });
  }
})();
