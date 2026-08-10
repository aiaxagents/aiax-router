/**
 * The mark and every service logo, copied byte for byte from the design
 * spec. These are official brand assets used for identification, so nothing
 * here is ever redrawn, recoloured or rebuilt by hand.
 */
export const SPRITE = String.raw`
<defs>
    <linearGradient id="aiaxg1" x1="13" y1="94" x2="63" y2="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#9FF5C7"/><stop offset="0.42" stop-color="#66D6A6"/><stop offset="1" stop-color="#E9FFF5"/>
    </linearGradient>
    <linearGradient id="aiaxg2" x1="45" y1="18" x2="84" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.45" stop-color="#CFEDE9"/><stop offset="1" stop-color="#56C8B4"/>
    </linearGradient>
    <symbol id="aiax-mark" viewBox="8 10 92 96">
      <path d="M51.6 17.2C56.7 17.2 61.3 20.2 63.4 24.9L91.3 87.2C94 93.4 86.3 99 81.1 94.7L59.8 77.3C56.9 75 52.8 74.9 49.9 77.2L26.7 95.5C21.4 99.7 13.9 93.9 16.8 87.8L44.1 24.9C45.5 20.2 46.7 17.2 51.6 17.2Z" fill="url(#aiaxg2)"/>
      <path d="M51.6 24.5L18.9 94.1C17.5 97.1 21.2 99.9 23.8 97.8L48.4 78.3C50.3 76.8 53 76.8 54.9 78.4L79.1 97.9C81.7 100 85.5 97.2 84.1 94.1L51.6 24.5Z" fill="url(#aiaxg1)"/>
      <path d="M51.4 31.4L35.4 67.5C34.6 69.3 36.6 71 38.3 70L49.2 63.6C50.7 62.7 52.6 62.7 54.1 63.6L65.3 70.2C67 71.2 69 69.4 68.1 67.6L51.4 31.4Z" fill="#FFFFFF" fill-opacity="0.98"/>
    </symbol>

    <symbol id="logo-claude" viewBox="0 0 24 24">
      <path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>
    </symbol>

    <symbol id="logo-openai" viewBox="0 0 24 24">
      <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
    </symbol>

    <symbol id="logo-kimi" viewBox="0 0 24 24">
      <path fill="currentColor" d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"/>
    </symbol>

    <symbol id="ic-clip" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
        d="M20 11.5l-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.6 1.6 0 0 1-2.2-2.2l7.2-7.2"/>
    </symbol>
    <symbol id="ic-mic" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
        d="M12 4.2a2.6 2.6 0 0 1 2.6 2.6v4.6a2.6 2.6 0 0 1-5.2 0V6.8A2.6 2.6 0 0 1 12 4.2zM6.4 11.2a5.6 5.6 0 0 0 11.2 0M12 16.8V20M9.4 20h5.2"/>
    </symbol>
    <symbol id="ic-send" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        d="M12 19V6M6 12l6-6 6 6"/>
    </symbol>
    <symbol id="ic-check" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5L20 6.5"/>
    </symbol>
    <symbol id="ic-chev" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/>
    </symbol>
    <symbol id="ic-search" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M20 20l-4.2-4.2"/>
      <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/>
    </symbol>
    <symbol id="ic-clock" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 7.6V12l3 1.8"/>
    </symbol>
    <symbol id="ic-repeat" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
        d="M4 11a7 7 0 0 1 12-4.9L19 9M20 13a7 7 0 0 1-12 4.9L5 15M19 5v4h-4M5 19v-4h4"/>
    </symbol>
    <symbol id="ic-pause" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M9.5 6.5v11M14.5 6.5v11"/>
    </symbol>
    <symbol id="ic-play" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M8 5.8l10 6.2-10 6.2z"/>
    </symbol>
    <symbol id="ic-chat" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M4 5h16v11H10l-6 4V5z"/>
    </symbol>
    <symbol id="ic-inbox" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M4 13h4l1.4 2.6h5.2L16 13h4M4 13 6.6 5h10.8L20 13v6H4z"/>
    </symbol>
    <symbol id="ic-agents" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 19a5.5 5.5 0 0 1 11 0M15.6 19a4 4 0 0 1 4.9-3.3"/>
      <circle cx="9.5" cy="9" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle cx="17.4" cy="10.6" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </symbol>
    <symbol id="ic-tasks" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" d="M4.8 4.5h2.4a.8.8 0 0 1 .8.8v13.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8zM10.8 4.5h2.4a.8.8 0 0 1 .8.8v7.9a.8.8 0 0 1-.8.8h-2.4a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8zM16.8 4.5h2.4a.8.8 0 0 1 .8.8v10.9a.8.8 0 0 1-.8.8h-2.4a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8z"/>
    </symbol>
    <symbol id="ic-plugins" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" d="M9 3v4M15 3v4M12 14v3.5a3 3 0 0 1-3 3H7.5"/>
      <rect x="6" y="7" width="12" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </symbol>
    <symbol id="ic-settings" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 7.5h8M18.6 7.5H20M4 16.5h2.4M13 16.5h7"/>
      <circle cx="15" cy="7.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle cx="9.4" cy="16.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </symbol>
  </defs>
`;
